import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  Inject,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { NotesRepository } from './notes.repository';
import {
  CreateNoteData,
  UpdateNoteData,
  ExtractLiteratureNoteResult,
} from './types/notes.types';
import {
  formatLiteratureNoteMarkdown,
  buildTipTapDocFromText,
} from './utils/notes.utils';
import {
  TransactionService,
  TransactionHelpers,
} from '../outbox/transaction.service';

import { normalizeTags } from '../tags/utils/tags.utils';
import { PrismaService } from '../../../core/database/prisma.service';
import { resolveTenantWorkspaceId } from '../../../core/utils/tenant.util';
import type {
  UpsertSyncNoteCommand,
  DeleteSyncEntityCommand,
  UpsertSyncEntityResult,
} from '../common/types/sync.types';
import {
  ITEM_READ_PORT,
  IItemReadPort,
  ITEM_EXISTENCE_PORT,
  IItemExistencePort,
  IItemNotesExtractorPort,
} from '../items/ports/items.ports';

@Injectable()
export class NotesService implements IItemNotesExtractorPort {
  private readonly logger = new Logger(NotesService.name);

  constructor(
    private readonly repo: NotesRepository,
    private readonly libraryTx: TransactionService,
    private readonly prisma: PrismaService,
    @Inject(ITEM_READ_PORT) private readonly itemReadPort: IItemReadPort,
    @Optional()
    @Inject(ITEM_EXISTENCE_PORT)
    private readonly itemExistencePort?: IItemExistencePort,
  ) {}

  private resolveWorkspaceId(workspaceId: string): Promise<string> {
    return resolveTenantWorkspaceId(this.prisma, workspaceId);
  }

  async listNotes(workspaceId: string, itemId?: string) {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    return this.repo.findMany(canonicalWorkspaceId, itemId);
  }

  async getNote(workspaceId: string, id: string) {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    return this.repo.findById(canonicalWorkspaceId, id);
  }

  async createNote(workspaceId: string, data: CreateNoteData) {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    if (data.itemId) {
      if (this.itemExistencePort) {
        await this.itemExistencePort.assertExists(
          canonicalWorkspaceId,
          data.itemId,
        );
      } else {
        const item = await this.itemReadPort.findById(
          canonicalWorkspaceId,
          data.itemId,
        );
        if (!item) {
          throw new NotFoundException(`Item not found in workspace`);
        }
      }
    }
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const note = await this.repo.create(canonicalWorkspaceId, data, tx);

      await helpers.appendChange(canonicalWorkspaceId, {
        entityType: 'Note',
        entityId: note.id,
        action: 'create',
        version: note.version,
        data: note,
      });

      await helpers.publishOutbox(
        canonicalWorkspaceId,
        note.id,
        'library.note.created',
        note,
      );

      return note;
    });
  }

  async updateNote(
    workspaceId: string,
    id: string,
    expectedVersion: number,
    data: UpdateNoteData,
  ) {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const updated = await this.repo.update(
        canonicalWorkspaceId,
        id,
        expectedVersion,
        data,
        tx,
      );

      await helpers.appendChange(canonicalWorkspaceId, {
        entityType: 'Note',
        entityId: updated.id,
        action: 'update',
        version: updated.version,
        data: updated,
      });

      await helpers.publishOutbox(
        canonicalWorkspaceId,
        updated.id,
        'library.note.updated',
        updated,
      );

      return updated;
    });
  }

  async deleteNote(
    workspaceId: string,
    id: string,
    expectedVersion?: number,
  ): Promise<boolean> {
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const deleted = await this.repo.softDelete(
        canonicalWorkspaceId,
        id,
        expectedVersion,
        tx,
      );

      if (deleted) {
        await helpers.recordTombstone(canonicalWorkspaceId, {
          entityType: 'Note',
          entityId: id,
        });

        await helpers.publishOutbox(
          canonicalWorkspaceId,
          id,
          'library.note.deleted',
          {
            id,
            deletedAt: new Date(),
          },
        );
      }

      return deleted;
    });
  }

  /**
   * Sync protocol adapter: transactional upsert for a Note from an external sync batch.
   */
  async upsertFromSync(
    command: UpsertSyncNoteCommand,
    tx: Prisma.TransactionClient,
    helpers: TransactionHelpers,
  ): Promise<UpsertSyncEntityResult> {
    if (command.existingId) {
      const existing = await tx.note.findUnique({
        where: { id: command.existingId },
      });

      if (!existing) {
        throw new NotFoundException(
          `Note ${command.existingId} not found in workspace ${command.workspaceId}`,
        );
      }

      if (existing.workspaceId !== command.workspaceId) {
        throw new ForbiddenException(
          `Note ${command.existingId} does not belong to workspace ${command.workspaceId}`,
        );
      }

      const mergedNoteTags =
        command.tags !== undefined
          ? normalizeTags([...(existing.tags || []), ...command.tags])
          : existing.tags;

      const updated = await tx.note.update({
        where: { id: command.existingId },
        data: {
          contentMd: command.contentMd,
          title: command.title,
          tags: mergedNoteTags,
          version: { increment: 1 },
        },
      });

      await helpers.appendChange(command.workspaceId, {
        entityType: 'Note',
        entityId: updated.id,
        action: 'update',
        version: updated.version,
      });

      return { id: updated.id, isNew: false, version: updated.version };
    } else {
      const created = await tx.note.create({
        data: {
          workspaceId: command.workspaceId,
          createdById: command.userId,
          itemId: command.itemId,
          contentMd: command.contentMd,
          title: command.title || 'Note',
          tags: command.tags ? normalizeTags(command.tags) : [],
          version: 1,
        },
      });

      await helpers.appendChange(command.workspaceId, {
        entityType: 'Note',
        entityId: created.id,
        action: 'create',
        version: 1,
      });

      await helpers.publishOutbox(
        command.workspaceId,
        created.id,
        'library.note.created',
        { noteId: created.id },
      );

      return { id: created.id, isNew: true, version: 1 };
    }
  }

  /**
   * Sync protocol adapter: transactional soft-delete for a Note from an external sync batch.
   */
  async deleteFromSync(
    command: DeleteSyncEntityCommand,
    tx: Prisma.TransactionClient,
    helpers: TransactionHelpers,
  ): Promise<void> {
    const { workspaceId, entityId } = command;
    const canonicalWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    const existing = await tx.note.findFirst({
      where: {
        id: entityId,
        workspaceId: canonicalWorkspaceId,
        deletedAt: null,
      },
    });
    if (!existing) return;

    await tx.note.updateMany({
      where: { id: entityId, workspaceId: canonicalWorkspaceId },
      data: { deletedAt: new Date() },
    });
    await helpers.appendChange(canonicalWorkspaceId, {
      entityType: 'Note',
      entityId,
      action: 'delete',
      version: existing.version + 1,
    });
  }

  /**
   * Domain merge helper: reassigns all notes from source duplicate items to target item.
   */
  async reassignToItem(
    sourceItemIds: string[],
    targetItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    if (sourceItemIds.length === 0) return;
    await tx.note.updateMany({
      where: { itemId: { in: sourceItemIds } },
      data: { itemId: targetItemId },
    });
  }

  /**
   * Ingestion helper: creates literature notes from ingestion pipelines (avoids bypass).
   */
  async createLiteratureNote(
    workspaceId: string,
    itemId: string,
    userId: string,
    content: string,
    source?: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const trimmed = content.trim();
    if (!trimmed) return;

    const createFn = async (client: Prisma.TransactionClient) => {
      const existing = await client.note.findFirst({
        where: {
          workspaceId,
          itemId,
          contentMd: trimmed,
          deletedAt: null,
        },
      });
      if (existing) return;

      await client.note.create({
        data: {
          workspaceId,
          itemId,
          title: source ? `Imported Note (${source})` : 'Imported Note',
          contentMd: trimmed,
          contentJson: {
            type: 'doc',
            content: [{ type: 'paragraph', text: trimmed }],
          },
          createdById: userId || 'system',
          tags: ['imported', ...(source ? [source] : [])],
          version: 1,
        },
      });
    };

    if (tx) {
      await createFn(tx);
    } else {
      await this.libraryTx.executeInTransaction(async (t) => {
        await createFn(t);
      });
    }
  }

  async extractNotesFromAnnotations(
    workspaceId: string,
    itemId: string,
    userId: string,
  ) {
    const canonicalWorkspaceId = await resolveTenantWorkspaceId(
      this.prisma,
      workspaceId,
    );

    const item = await this.itemReadPort.findById(canonicalWorkspaceId, itemId);
    if (!item) {
      throw new NotFoundException(
        `Item ${itemId} not found in workspace ${canonicalWorkspaceId}`,
      );
    }

    const attachments = await this.prisma.attachment.findMany({
      where: { itemId },
      select: { id: true, filename: true },
    });

    const attachmentIds = attachments.map((a: { id: string }) => a.id);
    const annotations =
      attachmentIds.length > 0
        ? await this.prisma.annotation.findMany({
            where: { attachmentId: { in: attachmentIds }, deletedAt: null },
            orderBy: [{ pageIndex: 'asc' }, { createdAt: 'asc' }],
          })
        : [];

    if (annotations.length === 0) {
      return {
        success: true,
        totalExtracted: 0,
        message: 'No annotations found for this item',
      };
    }

    const markdown = formatLiteratureNoteMarkdown(item, annotations);

    const note = await this.createNote(canonicalWorkspaceId, {
      itemId,
      title: `Literature Notes — ${item.title?.slice(0, 50) || 'Untitled'}`,
      contentMd: markdown,
      contentJson: buildTipTapDocFromText(markdown),
      createdById: userId || 'system',
      tags: ['literature-note', 'highlights'],
    });

    return {
      success: true,
      totalExtracted: annotations.length,
      literatureNote: note,
    } as ExtractLiteratureNoteResult;
  }
}
