import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  Inject,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { NotesRepository } from '../../infrastructure/repositories/notes.repository';
import {
  CreateNoteData,
  UpdateNoteData,
  ExtractLiteratureNoteResult,
} from '../../domain/types/notes.types';
import {
  formatLiteratureNoteMarkdown,
  buildTipTapDocFromText,
  sanitizeNoteTitle,
  sanitizeNoteContent,
} from '../utils/notes.utils';
import {
  TransactionService,
  TransactionHelpers,
} from '../../../shared-kernel/outbox/transaction.service';

import { normalizeTags } from '../../../shared-kernel/utils/tag.utils';
import type {
  UpsertSyncNoteCommand,
  DeleteSyncEntityCommand,
  UpsertSyncEntityResult,
} from '../../../shared-kernel/core/types/entity-commands.types';
import {
  BIBLIOGRAPHY_FACADE,
  IBibliographyFacade,
} from '../../../bibliography/bibliography.facade';

@Injectable()
export class NotesService {
  private readonly logger = new Logger(NotesService.name);

  constructor(
    private readonly repo: NotesRepository,
    private readonly libraryTx: TransactionService,
    @Optional()
    @Inject(BIBLIOGRAPHY_FACADE)
    private readonly bibliographyFacade?: IBibliographyFacade,
  ) {}

  async listNotes(userId: string, itemId?: string, projectId?: string) {
    return this.repo.findMany(userId, itemId, projectId);
  }

  async getNote(userId: string, id: string, projectId?: string) {
    return this.repo.findById(userId, id, undefined, projectId);
  }

  async createNote(userId: string, data: CreateNoteData) {
    if (data.itemId && this.bibliographyFacade) {
      const exists = await this.bibliographyFacade.itemExists(
        userId,
        data.itemId,
        data.projectId,
      );
      if (!exists) {
        throw new NotFoundException(`Item not found`);
      }
    }
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const sanitizedData: CreateNoteData = {
        ...data,
        title: sanitizeNoteTitle(data.title),
        contentMd:
          data.contentMd !== undefined
            ? sanitizeNoteContent(data.contentMd)
            : '',
      };
      const note = await this.repo.create(userId, sanitizedData, tx);
      const effectiveProjectId = sanitizedData.projectId;
      const eventScope = { userId, projectId: effectiveProjectId };

      await helpers.appendChange(eventScope, {
        entityType: 'Note',
        entityId: note.id,
        action: 'create',
        version: note.version,
        data: note,
      });

      await helpers.publishOutbox(
        eventScope,
        note.id,
        'library.note.created',
        note,
      );

      return note;
    });
  }

  async updateNote(
    userId: string,
    id: string,
    expectedVersion: number,
    data: UpdateNoteData,
    projectId?: string,
  ) {
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const sanitizedData: UpdateNoteData = {
        ...data,
        ...(data.title !== undefined
          ? { title: sanitizeNoteTitle(data.title) }
          : {}),
        ...(data.contentMd !== undefined
          ? { contentMd: sanitizeNoteContent(data.contentMd) }
          : {}),
      };
      const updated = await this.repo.update(
        userId,
        id,
        expectedVersion,
        sanitizedData,
        tx,
        projectId,
      );

      const effectiveProjectId =
        projectId || (updated as any).projectId || undefined;
      const eventScope = { userId, projectId: effectiveProjectId };

      await helpers.appendChange(eventScope, {
        entityType: 'Note',
        entityId: updated.id,
        action: 'update',
        version: updated.version,
        data: updated,
      });

      await helpers.publishOutbox(
        eventScope,
        updated.id,
        'library.note.updated',
        updated,
      );

      return updated;
    });
  }

  async deleteNote(
    userId: string,
    id: string,
    expectedVersion?: number,
    projectId?: string,
  ): Promise<boolean> {
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const existing = await this.repo.findById(userId, id, tx, projectId);
      const deleted = await this.repo.softDelete(
        userId,
        id,
        expectedVersion,
        tx,
        projectId,
      );

      if (deleted) {
        const effectiveProjectId =
          projectId || existing?.projectId || undefined;
        const eventScope = { userId, projectId: effectiveProjectId };

        await helpers.recordTombstone(eventScope, {
          entityType: 'Note',
          entityId: id,
        });

        await helpers.publishOutbox(eventScope, id, 'library.note.deleted', {
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
    const targetUserId = command.userId || (command as any).projectId || '';
    if (command.existingId) {
      const existing = await tx.note.findUnique({
        where: { id: command.existingId },
      });

      if (!existing) {
        throw new NotFoundException(`Note ${command.existingId} not found`);
      }

      if (
        existing.userId !== targetUserId &&
        existing.projectId !== command.projectId
      ) {
        throw new ForbiddenException('Not authorized to update this note');
      }

      // Sync is authoritative: replace tags entirely rather than accumulate
      const mergedNoteTags =
        command.tags !== undefined
          ? normalizeTags(command.tags)
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

      const noteProjectId =
        command.projectId || existing.projectId || undefined;
      const syncScope = { userId: targetUserId, projectId: noteProjectId };

      await helpers.appendChange(syncScope, {
        entityType: 'Note',
        entityId: updated.id,
        action: 'update',
        version: updated.version,
      });

      return { id: updated.id, isNew: false, version: updated.version };
    } else {
      const noteProjectId =
        command.projectId || (command as any).projectId || undefined;
      const syncScope = { userId: targetUserId, projectId: noteProjectId };

      const created = await tx.note.create({
        data: {
          userId: targetUserId,
          projectId: noteProjectId || null,
          createdById: command.userId,
          itemId: command.itemId,
          contentMd: command.contentMd,
          title: command.title || 'Note',
          tags: command.tags ? normalizeTags(command.tags) : [],
          version: 1,
        },
      });

      await helpers.appendChange(syncScope, {
        entityType: 'Note',
        entityId: created.id,
        action: 'create',
        version: 1,
      });

      await helpers.publishOutbox(
        syncScope,
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
    const targetUserId = command.userId || (command as any).projectId || '';
    const { entityId } = command;
    const existing = await tx.note.findFirst({
      where: {
        id: entityId,
        ...(targetUserId ? { userId: targetUserId } : {}),
        deletedAt: null,
      },
    });
    if (!existing) return;

    const noteProjectId =
      existing.projectId ||
      command.projectId ||
      (command as any).projectId ||
      undefined;
    const syncScope = { userId: targetUserId, projectId: noteProjectId };

    await tx.note.updateMany({
      where: { id: entityId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    await helpers.appendChange(syncScope, {
      entityType: 'Note',
      entityId,
      action: 'delete',
      version: existing.version + 1,
    });
    await helpers.recordTombstone(syncScope, {
      entityType: 'Note',
      entityId,
      deletedById: targetUserId || undefined,
    });
  }

  /**
   * Domain merge helper: reassigns all notes from source duplicate items to target item.
   */
  async reassignToItem(
    sourceItemIds: string[],
    targetItemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    return this.repo.reassignToItem(sourceItemIds, targetItemId, tx);
  }

  /**
   * Ingestion helper: creates literature notes from ingestion pipelines (avoids bypass).
   */
  async createLiteratureNote(
    userId: string,
    itemId: string,
    content: string,
    source?: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    return this.repo.createLiteratureNote(userId, itemId, content, source, tx);
  }

  async extractNotesFromAnnotations(userId: string, itemId: string) {
    const item = this.bibliographyFacade
      ? await this.bibliographyFacade.getItem(userId, itemId)
      : null;
    if (!item) {
      throw new NotFoundException(`Item ${itemId} not found`);
    }

    const annotations = await this.repo.findItemAnnotations(itemId);

    if (annotations.length === 0) {
      return {
        success: true,
        totalExtracted: 0,
        message: 'No annotations found for this item',
      };
    }

    const markdown = formatLiteratureNoteMarkdown(item, annotations);

    const note = await this.createNote(userId, {
      itemId,
      projectId: (item as any).projectId || undefined,
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
