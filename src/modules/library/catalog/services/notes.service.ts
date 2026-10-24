import {
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RedisCacheService } from '@/core';
import { ItemCacheCoordinator } from './item-cache.coordinator';
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
import {
  TransactionHelpers,
  normalizeProjectScopeId,
  ConfigurationException,
} from '@/modules/library/core';
import { TransactionService } from '@/modules/library/sync';
import { normalizeAcademicTags } from '@/modules/library/core/domain/tag.domain';
import { ItemQueryService } from './item-query.service';

@Injectable()
export class NotesService {
  private readonly logger = new Logger(NotesService.name);

  private readonly cacheCoordinator: ItemCacheCoordinator;

  constructor(
    private readonly repo: NotesRepository,
    private readonly libraryTx: TransactionService,
    @Optional()
    private readonly itemQuery?: ItemQueryService,
    @Optional()
    cacheOrCoordinator?: RedisCacheService | ItemCacheCoordinator,
    @Optional()
    injectedCoordinator?: ItemCacheCoordinator,
  ) {
    if (injectedCoordinator) {
      this.cacheCoordinator = injectedCoordinator;
    } else if (cacheOrCoordinator instanceof ItemCacheCoordinator) {
      this.cacheCoordinator = cacheOrCoordinator;
    } else {
      this.cacheCoordinator = new ItemCacheCoordinator(cacheOrCoordinator);
    }
  }

  private async invalidateNoteItemCaches(
    userId?: string,
    projectId?: string | null,
    itemId?: string | null,
  ): Promise<void> {
    const validProjectId = normalizeProjectScopeId(projectId);
    if (itemId) {
      await this.cacheCoordinator.invalidateItemCache(
        itemId,
        userId,
        validProjectId,
      );
    } else if (userId) {
      await this.cacheCoordinator.invalidateScopeListCache(
        userId,
        validProjectId,
      );
    }
  }

  async listNotes(userId: string, itemId?: string, projectId?: string) {
    return this.repo.findMany(userId, itemId, projectId);
  }

  async getNote(userId: string, id: string, projectId?: string) {
    return this.repo.findById(userId, id, undefined, projectId);
  }

  async createNote(userId: string, data: CreateNoteData) {
    if (data.itemId && this.itemQuery) {
      const exists = await this.itemQuery.exists(
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
        const effectiveProjectId = normalizeProjectScopeId(
          sanitizedData.projectId,
        );
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
    data: UpdateNoteData,
    projectId?: string,
  ) {
    const resolvedVersion = data?.expectedVersion;
    const effectiveProjectId = normalizeProjectScopeId(projectId);

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
          resolvedVersion,
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
    const validProjectId = normalizeProjectScopeId(projectId);
    let deletedItemId: string | null | undefined;
    let deletedProjectId: string | undefined = validProjectId;

    const deleted = await this.libraryTx.executeInTransaction(
      async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
        const existing = await this.repo.findById(
          userId,
          id,
          tx,
          validProjectId,
        );
        deletedItemId = existing?.itemId;
        deletedProjectId = validProjectId || existing?.projectId || undefined;

        const isDeleted = await this.repo.softDelete(
          userId,
          id,
          expectedVersion,
          tx,
          validProjectId,
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
    options?: FormatNoteOptions,
    projectId?: string,
  ) {
    const opts: FormatNoteOptions = {
      ...options,
      ...(projectId ? { projectId } : {}),
    };
    if (!this.itemQuery) {
      throw new ConfigurationException(
        'ItemQueryService is required to extract notes from annotations',
      );
    }
    const item = await this.itemQuery.findById(userId, itemId, opts.projectId);
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
    const effectiveProjectId = normalizeProjectScopeId(
      opts.projectId ||
        ('projectId' in item && typeof item.projectId === 'string'
          ? item.projectId
          : undefined),
    );

    if (opts.noteId) {
      const existingNote = await this.getNote(
        userId,
        opts.noteId,
        effectiveProjectId,
      );
      if (existingNote) {
        const mergedTags = normalizeAcademicTags([
          ...(Array.isArray(existingNote.tags) ? existingNote.tags : []),
          'literature-note',
          'highlights',
        ]);
        const updatedNote = await this.updateNote(
          userId,
          existingNote.id,
          {
            expectedVersion: existingNote.version,
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
