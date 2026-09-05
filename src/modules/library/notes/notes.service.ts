import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  NotesRepository,
  CreateNoteData,
  UpdateNoteData,
} from './notes.repository';
import {
  TransactionService,
  TransactionHelpers,
} from '../outbox/transaction.service';
import type {
  UpsertSyncNoteCommand,
  DeleteSyncEntityCommand,
  UpsertSyncEntityResult,
} from '../sync/ports/sync.port';
import { normalizeTags } from '../tags/utils/tags.utils';
import { PrismaService } from '../../../core/database/prisma.service';
import { resolveTenantWorkspaceId } from '../../../core/utils/tenant.util';

@Injectable()
export class NotesService {
  private readonly logger = new Logger(NotesService.name);

  constructor(
    private readonly notesRepo: NotesRepository,
    private readonly libraryTx: TransactionService,
    private readonly prisma: PrismaService,
  ) {}

  async listNotes(workspaceId: string, itemId?: string) {
    return this.notesRepo.findMany(workspaceId, itemId);
  }

  async getNote(workspaceId: string, id: string) {
    return this.notesRepo.findById(workspaceId, id);
  }

  async createNote(workspaceId: string, data: CreateNoteData) {
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const note = await this.notesRepo.create(workspaceId, data, tx);

      await helpers.appendChange(workspaceId, {
        entityType: 'Note',
        entityId: note.id,
        action: 'create',
        version: note.version,
        data: note,
      });

      await helpers.publishOutbox(
        workspaceId,
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
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const updated = await this.notesRepo.update(
        workspaceId,
        id,
        expectedVersion,
        data,
        tx,
      );

      await helpers.appendChange(workspaceId, {
        entityType: 'Note',
        entityId: updated.id,
        action: 'update',
        version: updated.version,
        data: updated,
      });

      await helpers.publishOutbox(
        workspaceId,
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
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const deleted = await this.notesRepo.softDelete(
        workspaceId,
        id,
        expectedVersion,
        tx,
      );

      if (deleted) {
        await helpers.recordTombstone(workspaceId, {
          entityType: 'Note',
          entityId: id,
        });

        await helpers.publishOutbox(workspaceId, id, 'library.note.deleted', {
          id,
          deletedAt: new Date(),
        });
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
          itemId: command.catalogItemId,
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
    const existing = await tx.note.findUnique({ where: { id: entityId } });
    if (!existing) return;

    if (existing.workspaceId !== workspaceId) {
      throw new ForbiddenException(
        `Note ${entityId} does not belong to workspace ${workspaceId}`,
      );
    }

    await tx.note.update({
      where: { id: entityId },
      data: { deletedAt: new Date() },
    });
    await helpers.appendChange(workspaceId, {
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
    const wsId = await resolveTenantWorkspaceId(this.prisma, workspaceId);

    const item = await this.prisma.catalogItem.findFirst({
      where: { id: itemId, workspaceId: wsId, deletedAt: null },
      include: {
        contributors: {
          orderBy: { orderIndex: 'asc' },
        },
      },
    });
    if (!item) {
      throw new NotFoundException(
        `Item ${itemId} not found in workspace ${wsId}`,
      );
    }

    const attachments = await this.prisma.catalogAttachment.findMany({
      where: { catalogItemId: itemId },
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

    const lines: string[] = [
      `# Literature Notes: ${item.title || 'Untitled'}`,
      '',
      `**Authors:** ${Array.isArray(item.contributors) ? item.contributors.map((c: any) => c.fullName || `${c.firstName || ''} ${c.lastName || ''}`.trim()).join(', ') : 'Unknown'}  `,
      `**Year:** ${item.year || 'N/A'} | **DOI:** ${item.doi || 'N/A'}`,
      '',
      '---',
      '',
      '## Extracted Highlights & Annotations',
      '',
    ];

    let currentPage = -1;
    for (const ann of annotations) {
      if (ann.pageIndex !== currentPage) {
        currentPage = ann.pageIndex;
        lines.push(`### Page ${currentPage + 1}`);
        lines.push('');
      }

      if (ann.quoteText) {
        lines.push(`> ${ann.quoteText.trim().replace(/\\n+/g, '\n> ')}`);
        lines.push('');
      }

      if (ann.comment) {
        lines.push(`**Note:** ${ann.comment.trim()}`);
        lines.push('');
      }
    }

    const markdown = lines.join('\n');

    const note = await this.createNote(wsId, {
      itemId,
      title: `Literature Notes — ${item.title?.slice(0, 50) || 'Untitled'}`,
      contentMd: markdown,
      contentJson: {
        type: 'doc',
        content: [{ type: 'paragraph', text: markdown }],
      },
      createdById: userId || 'system',
      tags: ['literature-note', 'highlights'],
    });

    return {
      success: true,
      totalExtracted: annotations.length,
      literatureNote: note,
    };
  }
}
