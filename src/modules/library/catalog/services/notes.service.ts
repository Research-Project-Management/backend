import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  Optional,
  Inject,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RedisCacheService } from '@/core';
import { LIBRARY_REDIS_KEYS } from '@/modules/library/core/constants/redis-keys.constants';
import { NotesRepository } from '@/modules/library/catalog/repositories/notes.repository';
import {
  CreateNoteData,
  UpdateNoteData,
  ExtractLiteratureNoteResult,
} from '@/modules/library/catalog/types/notes.types';
import {
  formatLiteratureNoteMarkdown,
  FormatNoteOptions,
  sanitizeNoteTitle,
  sanitizeNoteContent,
} from '@/modules/library/catalog/domain/notes.domain';
import { buildTipTapDocFromText } from '@/modules/library/core/domain/tiptap.domain';
import { TransactionService, TransactionHelpers } from '@/modules/library/core';
import { normalizeTags } from '@/modules/library/core/domain/tag.domain';
import type {
  UpsertSyncNoteCommand,
  DeleteSyncEntityCommand,
  UpsertSyncEntityResult,
} from '@/modules/library/core/types/entity-commands.types';
import {
  ITEM_EXISTENCE_PORT,
  ITEM_READ_PORT,
  IItemExistencePort,
  IItemReadPort,
} from '@/modules/library/catalog/types/items.types';

@Injectable()
export class NotesService {
  private readonly logger = new Logger(NotesService.name);

  constructor(
    private readonly repo: NotesRepository,
    private readonly libraryTx: TransactionService,
    @Optional()
    @Inject(ITEM_EXISTENCE_PORT)
    private readonly itemExistencePort?: IItemExistencePort,
    @Optional()
    @Inject(ITEM_READ_PORT)
    private readonly itemReadPort?: IItemReadPort,
    @Optional()
    private readonly cache?: RedisCacheService,
  ) {}

  private async invalidateNoteItemCaches(
    userId?: string,
    projectId?: string | null,
    itemId?: string | null,
  ): Promise<void> {
    if (!this.cache) return;
    try {
      const tasks: Promise<unknown>[] = [];
      if (itemId) {
        tasks.push(
          this.cache.del(LIBRARY_REDIS_KEYS.item(itemId)),
          this.cache.del(LIBRARY_REDIS_KEYS.itemDetails(itemId)),
          this.cache.delPattern(LIBRARY_REDIS_KEYS.itemPattern(itemId)),
        );
      }
      if (userId) {
        tasks.push(
          this.cache.delPattern(LIBRARY_REDIS_KEYS.itemsPattern(userId)),
          this.cache.del(`library:counts:user:${userId}`),
        );
      }
      if (
        projectId &&
        projectId !== 'user' &&
        projectId !== 'me' &&
        projectId !== 'personal'
      ) {
        tasks.push(
          this.cache.delPattern(
            LIBRARY_REDIS_KEYS.itemsPattern(`proj:${projectId}`),
          ),
          this.cache.del(`library:counts:proj:${projectId}`),
        );
      }
      if (tasks.length > 0) {
        await Promise.all(tasks);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to invalidate note item cache: ${message}`);
    }
  }

  async listNotes(userId: string, itemId?: string, projectId?: string) {
    return this.repo.findMany(userId, itemId, projectId);
  }

  async getNote(userId: string, id: string, projectId?: string) {
    return this.repo.findById(userId, id, undefined, projectId);
  }

  async createNote(userId: string, data: CreateNoteData) {
    if (data.itemId && this.itemExistencePort) {
      const exists = await this.itemExistencePort.exists(
        userId,
        data.itemId,
        data.projectId,
      );
      if (!exists) {
        throw new NotFoundException(`Item not found`);
      }
    }
    const createdNote = await this.libraryTx.executeInTransaction(
      async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
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
      },
    );

    await this.invalidateNoteItemCaches(
      userId,
      createdNote?.projectId ?? data.projectId,
      createdNote?.itemId ?? data.itemId,
    );
    return createdNote;
  }

  async updateNote(
    userId: string,
    id: string,
    expectedVersionOrData: number | undefined | UpdateNoteData,
    dataOrProjectId?: UpdateNoteData | string,
    projectId?: string,
  ) {
    let expectedVersion: number | undefined;
    let data: UpdateNoteData;
    let effectiveProjectId = projectId;

    if (
      typeof expectedVersionOrData === 'number' ||
      (expectedVersionOrData === undefined &&
        dataOrProjectId !== undefined &&
        typeof dataOrProjectId === 'object')
    ) {
      expectedVersion = expectedVersionOrData;
      data = (dataOrProjectId as UpdateNoteData) || {};
    } else {
      data = (expectedVersionOrData as UpdateNoteData) || {};
      effectiveProjectId =
        typeof dataOrProjectId === 'string' ? dataOrProjectId : projectId;
      expectedVersion = data?.expectedVersion;
    }

    if (expectedVersion === undefined && data?.expectedVersion !== undefined) {
      expectedVersion = data.expectedVersion;
    }

    const updatedNote = await this.libraryTx.executeInTransaction(
      async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
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
          effectiveProjectId,
        );

        const noteProjectId =
          effectiveProjectId ||
          ('projectId' in updated && typeof updated.projectId === 'string'
            ? updated.projectId
            : undefined);
        const eventScope = { userId, projectId: noteProjectId };

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
      },
    );

    await this.invalidateNoteItemCaches(
      userId,
      updatedNote?.projectId ?? effectiveProjectId,
      updatedNote?.itemId,
    );
    return updatedNote;
  }

  async deleteNote(
    userId: string,
    id: string,
    expectedVersion?: number,
    projectId?: string,
  ): Promise<boolean> {
    let deletedItemId: string | null | undefined;
    let deletedProjectId: string | undefined = projectId;

    const deleted = await this.libraryTx.executeInTransaction(
      async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
        const existing = await this.repo.findById(userId, id, tx, projectId);
        deletedItemId = existing?.itemId;
        deletedProjectId = projectId || existing?.projectId || undefined;

        const isDeleted = await this.repo.softDelete(
          userId,
          id,
          expectedVersion,
          tx,
          projectId,
        );

        if (isDeleted) {
          const eventScope = { userId, projectId: deletedProjectId };

          await helpers.recordTombstone(eventScope, {
            entityType: 'Note',
            entityId: id,
          });

          await helpers.publishOutbox(eventScope, id, 'library.note.deleted', {
            id,
            deletedAt: new Date(),
          });
        }

        return isDeleted;
      },
    );

    if (deleted) {
      await this.invalidateNoteItemCaches(
        userId,
        deletedProjectId,
        deletedItemId,
      );
    }

    return deleted;
  }

  async upsertFromSync(
    command: UpsertSyncNoteCommand,
    tx: Prisma.TransactionClient,
    helpers: TransactionHelpers,
  ): Promise<UpsertSyncEntityResult> {
    const targetUserId = command.userId || command.projectId || '';
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

      const mergedNoteTags =
        command.tags !== undefined
          ? normalizeTags(command.tags)
          : existing.tags;

      const sanitizedMd =
        command.contentMd !== undefined
          ? sanitizeNoteContent(command.contentMd)
          : existing.contentMd;

      const updated = await tx.note.update({
        where: { id: command.existingId },
        data: {
          contentMd: sanitizedMd,
          ...(command.contentMd !== undefined
            ? {
                contentJson: buildTipTapDocFromText(
                  sanitizedMd ?? '',
                ) as Prisma.InputJsonValue,
              }
            : {}),
          title:
            command.title !== undefined
              ? sanitizeNoteTitle(command.title)
              : existing.title,
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

      await this.invalidateNoteItemCaches(
        targetUserId,
        noteProjectId,
        updated.itemId,
      );

      return { id: updated.id, isNew: false, version: updated.version };
    } else {
      const noteProjectId = command.projectId || undefined;
      const syncScope = { userId: targetUserId, projectId: noteProjectId };
      const sanitizedMd = sanitizeNoteContent(command.contentMd);

      const created = await tx.note.create({
        data: {
          userId: targetUserId,
          projectId: noteProjectId || null,
          createdById: command.userId,
          itemId: command.itemId,
          contentMd: sanitizedMd,
          contentJson: buildTipTapDocFromText(
            sanitizedMd,
          ) as Prisma.InputJsonValue,
          title: sanitizeNoteTitle(command.title || 'Note'),
          tags: command.tags ? normalizeTags(command.tags) : [],
          version: 1,
        },
      });

      if (command.itemId) {
        await this.repo.syncItemNoteCount(command.itemId, tx);
      }

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

      await this.invalidateNoteItemCaches(
        targetUserId,
        noteProjectId,
        command.itemId,
      );

      return { id: created.id, isNew: true, version: 1 };
    }
  }

  async deleteFromSync(
    command: DeleteSyncEntityCommand,
    tx: Prisma.TransactionClient,
    helpers: TransactionHelpers,
  ): Promise<void> {
    const targetUserId = command.userId || command.projectId || '';
    const { entityId } = command;
    const existing = await tx.note.findFirst({
      where: {
        id: entityId,
        ...(targetUserId ? { userId: targetUserId } : {}),
        deletedAt: null,
      },
    });
    if (!existing) return;

    const noteProjectId = existing.projectId || command.projectId || undefined;
    const syncScope = { userId: targetUserId, projectId: noteProjectId };

    await tx.note.updateMany({
      where: { id: entityId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (existing.itemId) {
      await this.repo.syncItemNoteCount(existing.itemId, tx);
    }
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

    await this.invalidateNoteItemCaches(
      targetUserId,
      noteProjectId,
      existing.itemId,
    );
  }

  async reassignToItem(
    sourceItemIds: string[],
    targetItemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    return this.repo.reassignToItem(sourceItemIds, targetItemId, tx);
  }

  async createLiteratureNote(
    userId: string,
    itemId: string,
    content: string,
    source?: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    return this.repo.createLiteratureNote(userId, itemId, content, source, tx);
  }

  async extractNotesFromAnnotations(
    userId: string,
    itemId: string,
    options?: FormatNoteOptions | string,
  ) {
    const opts: FormatNoteOptions =
      typeof options === 'string' ? { projectId: options } : options || {};
    const item = this.itemReadPort
      ? await this.itemReadPort.findById(userId, itemId, opts.projectId)
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

    const markdown = formatLiteratureNoteMarkdown(item, annotations, opts);
    const effectiveProjectId =
      opts.projectId ||
      ('projectId' in item && typeof item.projectId === 'string'
        ? item.projectId
        : undefined);

    if (opts.noteId) {
      const existingNote = await this.getNote(
        userId,
        opts.noteId,
        effectiveProjectId,
      );
      if (existingNote) {
        const mergedTags = normalizeTags([
          ...(Array.isArray(existingNote.tags) ? existingNote.tags : []),
          'literature-note',
          'highlights',
        ]);
        const updatedNote = await this.updateNote(
          userId,
          existingNote.id,
          existingNote.version,
          {
            contentMd: markdown,
            contentJson: buildTipTapDocFromText(markdown),
            tags: mergedTags,
          },
          effectiveProjectId,
        );
        return {
          success: true,
          totalExtracted: annotations.length,
          literatureNote: updatedNote,
        } as ExtractLiteratureNoteResult;
      }
    }

    const note = await this.createNote(userId, {
      itemId,
      projectId: effectiveProjectId,
      title: `Literature Notes — ${item.title?.slice(0, 50) || 'Untitled'}`,
      contentMd: markdown,
      contentJson: buildTipTapDocFromText(markdown),
      createdById: userId,
      tags: ['literature-note', 'highlights'],
    });

    return {
      success: true,
      totalExtracted: annotations.length,
      literatureNote: note,
    } as ExtractLiteratureNoteResult;
  }
}
