import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RedisCacheService } from '@/core';
import { ItemCacheCoordinator } from './schema-validator.service';
import { NotesRepository } from '@/modules/library/catalog/repositories/notes.repository';
import {
  CreateNoteData,
  UpdateNoteData,
  ExtractLiteratureNoteResult,
} from '@/modules/library/catalog/types/catalog.types';
import {
  formatLiteratureNoteMarkdown,
  appendAnnotationsToLiteratureNoteMarkdown,
  isLiteratureNoteCandidate,
  FormatNoteOptions,
  sanitizeNoteTitle,
  sanitizeNoteContent,
} from '@/modules/library/catalog/domain/notes.domain';

import {
  TransactionHelpers,
  UNIT_OF_WORK,
  IUnitOfWork,
  normalizeProjectScopeId,
  ConfigurationException,
  LIBRARY_EVENT_TYPES,
} from '@/modules/library/core';
import { normalizeTags } from '@/modules/library/core/domain/tag.domain';
import { ItemQueryService } from './item-query.service';

@Injectable()
export class NotesService {
  private readonly logger = new Logger(NotesService.name);

  private readonly cacheCoordinator: ItemCacheCoordinator;

  constructor(
    private readonly repo: NotesRepository,
    @Optional() @Inject(UNIT_OF_WORK) private readonly libraryTx: IUnitOfWork,
    @Optional()
    private readonly itemQuery?: ItemQueryService,
    @Optional()
    @Inject(RedisCacheService)
    private readonly cache?: RedisCacheService,
    @Optional()
    @Inject(ItemCacheCoordinator)
    cacheCoordinator?: ItemCacheCoordinator,
  ) {
    this.cacheCoordinator =
      cacheCoordinator ?? new ItemCacheCoordinator(this.cache);
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
    if (data.contentJson !== undefined && data.contentJson !== null) {
      if (typeof data.contentJson !== 'object' || Array.isArray(data.contentJson)) {
        throw new BadRequestException('contentJson must be a valid JSON object');
      }
      const serialized = JSON.stringify(data.contentJson);
      if (serialized.length > 2_000_000) {
        throw new BadRequestException('contentJson exceeds maximum size of 2MB');
      }
    }
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
    let ranPostCommitHook = false;
    const createdNote = await this.libraryTx.executeInTransaction(
      async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
        ranPostCommitHook = Boolean(helpers?.onAfterCommit);
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
          LIBRARY_EVENT_TYPES.NOTE_CREATED,
          note,
        );

        helpers?.onAfterCommit?.(() =>
          this.invalidateNoteItemCaches(
            userId,
            note?.projectId ?? data.projectId,
            note?.itemId ?? data.itemId,
          ),
        );

        return note;
      },
    );

    if (!ranPostCommitHook) {
      await this.invalidateNoteItemCaches(
        userId,
        createdNote?.projectId ?? data.projectId,
        createdNote?.itemId ?? data.itemId,
      );
    }
    return createdNote;
  }

  async updateNote(
    userId: string,
    id: string,
    data: UpdateNoteData,
    projectId?: string,
  ) {
    if (data.contentJson !== undefined && data.contentJson !== null) {
      if (typeof data.contentJson !== 'object' || Array.isArray(data.contentJson)) {
        throw new BadRequestException('contentJson must be a valid JSON object');
      }
      const serialized = JSON.stringify(data.contentJson);
      if (serialized.length > 2_000_000) {
        throw new BadRequestException('contentJson exceeds maximum size of 2MB');
      }
    }
    const resolvedVersion = data?.expectedVersion;
    const effectiveProjectId = normalizeProjectScopeId(projectId);

    let ranPostCommitHook = false;
    const updatedNote = await this.libraryTx.executeInTransaction(
      async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
        ranPostCommitHook = Boolean(helpers?.onAfterCommit);
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
          LIBRARY_EVENT_TYPES.NOTE_UPDATED,
          updated,
        );

        helpers?.onAfterCommit?.(() =>
          this.invalidateNoteItemCaches(
            userId,
            updated?.projectId ?? effectiveProjectId,
            updated?.itemId,
          ),
        );

        return updated;
      },
    );

    if (!ranPostCommitHook) {
      await this.invalidateNoteItemCaches(
        userId,
        updatedNote?.projectId ?? effectiveProjectId,
        updatedNote?.itemId,
      );
    }
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
    let ranPostCommitHook = false;

    const deleted = await this.libraryTx.executeInTransaction(
      async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
        ranPostCommitHook = Boolean(helpers?.onAfterCommit);
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

          await helpers.appendChange(eventScope, {
            entityType: 'Note',
            entityId: id,
            action: 'delete',
            version: existing?.version ?? 1,
            data: { id, itemId: deletedItemId },
          });

          await helpers.recordTombstone(eventScope, {
            entityType: 'Note',
            entityId: id,
          });

          await helpers.publishOutbox(
            eventScope,
            id,
            LIBRARY_EVENT_TYPES.NOTE_DELETED,
            {
              id,
              itemId: deletedItemId,
              deletedAt: new Date(),
            },
          );

          helpers?.onAfterCommit?.(() =>
            this.invalidateNoteItemCaches(
              userId,
              deletedProjectId,
              deletedItemId,
            ),
          );
        }

        return isDeleted;
      },
    );

    if (deleted && !ranPostCommitHook) {
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
    projectId?: string | null,
  ): Promise<void> {
    return this.repo.createLiteratureNote(
      userId,
      itemId,
      content,
      source,
      tx,
      projectId,
    );
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

    const effectiveProjectId = normalizeProjectScopeId(
      opts.projectId ||
        ('projectId' in item && typeof item.projectId === 'string'
          ? item.projectId
          : undefined),
    );

    const hasFilterOpts =
      Boolean(opts.attachmentId) ||
      Boolean(opts.annotationIds && opts.annotationIds.length > 0);
    let annotations = hasFilterOpts
      ? await this.repo.findItemAnnotations(itemId, {
          attachmentId: opts.attachmentId,
          annotationIds: opts.annotationIds,
          userId,
          projectId: effectiveProjectId,
        })
      : await this.repo.findItemAnnotations(itemId, {
          userId,
          projectId: effectiveProjectId,
        });

    if (typeof opts.tagColor === 'string' && opts.tagColor.trim()) {
      const targetColor = opts.tagColor.trim().toLowerCase();
      if (targetColor !== 'true' && targetColor !== 'false') {
        annotations = annotations.filter(
          (a) => (a.color ?? '').toLowerCase() === targetColor,
        );
      }
    }

    if (annotations.length === 0) {
      return {
        success: true,
        totalExtracted: 0,
        message: 'No annotations found for this item',
      };
    }

    const extractedAnnotationTags = annotations.flatMap((a) =>
      Array.isArray(a.tags) ? a.tags : [],
    );

    const itemRecord = item as unknown as Record<string, unknown>;
    const rawItemNotes = Array.isArray(itemRecord.notes)
      ? (itemRecord.notes as Array<Record<string, unknown>>)
      : Array.isArray(itemRecord.notesList)
        ? (itemRecord.notesList as Array<Record<string, unknown>>)
        : [];

    const candidateNoteId =
      opts.noteId ||
      (opts as { targetNoteId?: string }).targetNoteId ||
      (() => {
        const foundLit = rawItemNotes.find(
          (n) => typeof n?.id === 'string' && isLiteratureNoteCandidate(n),
        );
        return typeof foundLit?.id === 'string' ? foundLit.id : undefined;
      })();

    if (candidateNoteId) {
      const preloadedCandidate = rawItemNotes.find(
        (n) =>
          n &&
          n.id === candidateNoteId &&
          !n.deletedAt &&
          (typeof n.contentMd === 'string' || typeof n.content === 'string'),
      );
      const existingNote = preloadedCandidate
        ? {
            id: String(preloadedCandidate.id),
            title:
              typeof preloadedCandidate.title === 'string'
                ? preloadedCandidate.title
                : 'Literature Notes',
            contentMd:
              typeof preloadedCandidate.contentMd === 'string'
                ? preloadedCandidate.contentMd
                : String(preloadedCandidate.content ?? ''),
            tags: Array.isArray(preloadedCandidate.tags)
              ? (preloadedCandidate.tags as string[])
              : [],
            version:
              typeof preloadedCandidate.version === 'number'
                ? preloadedCandidate.version
                : undefined,
          }
        : await this.getNote(
            userId,
            candidateNoteId,
            effectiveProjectId,
          ).catch(() => null);
      if (existingNote) {
        const mergedTags = normalizeTags(
          [
            ...(Array.isArray(existingNote.tags) ? existingNote.tags : []),
            'literature-note',
            'highlights',
            ...extractedAnnotationTags,
          ],
          { allowManualAcademicTerms: true },
        );
        const existingContent = (existingNote.contentMd || '').trim();
        const { markdown: nextMarkdown, addedCount } =
          appendAnnotationsToLiteratureNoteMarkdown(
            item,
            existingContent,
            annotations,
            opts,
          );

        const updatedNote =
          nextMarkdown !== existingContent ||
          mergedTags.length !== (existingNote.tags?.length ?? 0)
            ? await this.updateNote(
                userId,
                existingNote.id,
                {
                  expectedVersion: existingNote.version,
                  contentMd: nextMarkdown,
                  tags: mergedTags,
                },
                effectiveProjectId,
              )
            : existingNote;
        return {
          ...(updatedNote as unknown as Record<string, unknown>),
          success: true,
          noteId: updatedNote.id,
          totalExtracted: annotations.length,
          addedCount,
          literatureNote: updatedNote,
        } as unknown as ExtractLiteratureNoteResult;
      }
    }

    const markdown = formatLiteratureNoteMarkdown(item, annotations, opts);
    const note = await this.createNote(userId, {
      itemId,
      projectId: effectiveProjectId,
      title: `Literature Notes — ${item.title?.slice(0, 50) || 'Untitled'}`,
      contentMd: markdown,
      createdById: userId,
      tags: normalizeTags(
        ['literature-note', 'highlights', ...extractedAnnotationTags],
        { allowManualAcademicTerms: true },
      ),
    });

    return {
      ...(note as unknown as Record<string, unknown>),
      success: true,
      noteId: note.id,
      totalExtracted: annotations.length,
      literatureNote: note,
    } as ExtractLiteratureNoteResult;
  }

}
