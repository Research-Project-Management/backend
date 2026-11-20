/**
 * modules/pages/track-changes/services/review-suggestions.service.ts
 * Application service encapsulating track-change suggestions creation, listing,
 * atomic single/batch resolution with OCC Docstore patching, and live collab sync.
 */

import {
  Injectable,
  Inject,
  Optional,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PageChangeType } from '@prisma/client';
import { AuthenticatedRequest, isUuid } from '@/core';
import {
  LIVE_COLLABORATION_PORT,
  LiveCollaborationPort,
  NOOP_LIVE_COLLABORATION,
} from '@/modules/pages/core';
import { PageService } from '@/modules/pages/core/services/page.service';
import { UserResolverService } from '@/modules/pages/core/services/user-resolver.service';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import { ScopeRepository } from '@/modules/pages/docstore/repositories/scope.repository';
import { TrackChangesService } from '../track-changes.service';
import { TrackChangesRepository } from '../track-changes.repository';
import { TrackChange, TextRangeVo } from '../domain';
import { ReviewScopeRepository } from '../repositories/review-scope.repository';
import {
  broadcastReviewProjectEvent,
  resolveReviewDocAndProject,
  validateSuggestionRange,
  formatSuggestionItemDto,
} from './review.helpers';
import {
  formatDomainSuggestionItem,
  executeBatchResolveSuggestions,
  applySingleSuggestionDocPatch,
} from './review-suggestions.helper';

export interface CreateSuggestionBody {
  type?: string;
  suggestedText?: string;
  originalText?: string;
  fromLine?: number;
  fromColumn?: number;
  toLine?: number;
  toColumn?: number;
  spaceId?: string;
  [key: string]: unknown;
}

@Injectable()
export class ReviewSuggestionsService {
  private readonly logger = new Logger(ReviewSuggestionsService.name);
  private readonly liveCollab: LiveCollaborationPort;

  constructor(
    private readonly docstoreService: DocstoreService,
    private readonly reviewScopeRepo: ReviewScopeRepository,
    private readonly pageScopeRepo: ScopeRepository,
    private readonly userResolver: UserResolverService,
    private readonly pageService: PageService,
    @Optional() private readonly trackChangesService?: TrackChangesService,
    @Optional() private readonly trackChangesRepo?: TrackChangesRepository,
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional()
    @Inject(LIVE_COLLABORATION_PORT)
    liveCollabOrLegacyRef?: LiveCollaborationPort | unknown,
  ) {
    this.liveCollab =
      liveCollabOrLegacyRef &&
      typeof (liveCollabOrLegacyRef as LiveCollaborationPort)
        .applyExternalText === 'function'
        ? (liveCollabOrLegacyRef as LiveCollaborationPort)
        : NOOP_LIVE_COLLABORATION;
  }

  private resolveDoc(
    pageId: string,
    authorizedProjectId?: string | { id: string } | null,
  ) {
    return resolveReviewDocAndProject({
      pageScopeRepo: this.pageScopeRepo,
      pageService: this.pageService,
      pageId,
      authorizedProjectId,
      fallbackPrisma: this.reviewScopeRepo.getPrisma?.(),
    });
  }

  private async syncLiveDoc(
    projectId: string,
    docId: string,
    lines: string[],
  ): Promise<boolean> {
    try {
      return await this.liveCollab.applyExternalText(
        projectId,
        docId,
        lines.join('\n'),
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Failed to sync REST write into live session ${projectId}:${docId}: ${message}`,
      );
      return false;
    }
  }

  public async getSuggestions(
    pageId: string,
    status?: 'pending' | 'accepted' | 'rejected',
    routeProjectId?: string,
    authorizedProjectId?: string | { id: string } | null,
  ) {
    if (!isUuid(pageId)) return { suggestions: [] };
    try {
      const { docId: resolvedDocId, projectId: resolvedProj } =
        await this.resolveDoc(pageId, routeProjectId || authorizedProjectId);
      const targetProjectId =
        resolvedProj ||
        this.pageService.resolveActiveProjectId(authorizedProjectId) ||
        routeProjectId;
      const targetDocId = resolvedDocId || pageId;
      if (!targetProjectId || !this.trackChangesRepo) {
        return { suggestions: [] };
      }

      const domainChanges = await this.trackChangesRepo.listChangesByDoc(
        targetProjectId,
        targetDocId,
        status,
      );
      const userMap = await this.userResolver.resolveUserNames(
        domainChanges.map((s) => s.createdById),
      );
      return {
        suggestions: domainChanges.map((s) =>
          formatDomainSuggestionItem(s, userMap),
        ),
      };
    } catch {
      return { suggestions: [] };
    }
  }

  public async createSuggestion(
    pageId: string,
    body: CreateSuggestionBody,
    req: AuthenticatedRequest,
    routeProjectId?: string,
    authorizedProjectId?: string | { id: string } | null,
  ) {
    const userId = req?.user?.id || req?.user?.sub || null;
    const activeProj =
      this.pageService.resolveActiveProjectId(authorizedProjectId) ||
      routeProjectId;
    const {
      docId: resolvedDocId,
      projectId: docProjId,
      pageId: resolvedPageId,
    } = await this.resolveDoc(pageId, activeProj || body?.spaceId);
    const resolvedProj =
      docProjId ||
      activeProj ||
      body?.spaceId ||
      (await this.pageService.resolveProjectId(pageId));
    const targetDocId = resolvedDocId || pageId;
    if (!resolvedProj || !isUuid(resolvedProj) || !isUuid(targetDocId)) {
      throw new BadRequestException(
        'Valid pageId and associated project required to create a suggestion',
      );
    }
    if (!this.trackChangesRepo) {
      throw new BadRequestException('TrackChanges repository not available');
    }

    const type: PageChangeType =
      body.type === 'delete' ? PageChangeType.delete : PageChangeType.insert;
    const text = body.suggestedText || body.originalText || '';

    const userMap = await this.userResolver.resolveUserNames([userId]);
    const resolvedUser = userId ? userMap.get(userId) : undefined;
    const authorName =
      resolvedUser?.name ||
      req?.user?.name ||
      req?.user?.email?.split('@')[0] ||
      'Collaborator';
    const authorEmail = req?.user?.email || '';

    const { startLine, endLine, startCol, endCol } =
      validateSuggestionRange(body);
    const saved = await this.trackChangesRepo.saveChange(
      TrackChange.create({
        projectId: resolvedProj,
        spaceId: resolvedProj,
        pageId: resolvedPageId ?? null,
        docId: targetDocId,
        type: type === PageChangeType.delete ? 'delete' : 'insert',
        text,
        range: TextRangeVo.create({ startLine, startCol, endLine, endCol }),
        createdById: isUuid(userId) ? userId : null,
      }),
    );

    const suggestionPayload = {
      id: saved.id,
      pageId: targetDocId,
      page: targetDocId,
      projectPageId: targetDocId,
      authorId: userId || saved.createdById || 'anonymous',
      author: {
        id: userId || saved.createdById || 'anonymous',
        name: authorName,
        email: authorEmail,
      },
      type: saved.type,
      originalText: saved.type === 'delete' ? saved.text : '',
      suggestedText: saved.type === 'insert' ? saved.text : '',
      text: saved.text,
      fromLine: saved.range.startLine + 1,
      fromColumn: saved.range.startCol,
      toLine: saved.range.endLine + 1,
      toColumn: saved.range.endCol,
      status: saved.status,
      createdAt: saved.createdAt.toISOString(),
      updatedAt: saved.updatedAt.toISOString(),
    };

    broadcastReviewProjectEvent(
      this.eventEmitter,
      resolvedProj,
      'track-changes:created',
      { docId: targetDocId, suggestion: suggestionPayload },
    );

    return { suggestion: suggestionPayload };
  }

  public acceptSuggestion(
    pageId: string,
    suggestionId: string,
    routeProjectId?: string,
    authorizedProjectId?: string | { id: string } | null,
    userId?: string,
  ) {
    return this.resolveSingleSuggestion(
      true,
      pageId,
      suggestionId,
      routeProjectId,
      authorizedProjectId,
      userId,
    );
  }

  public rejectSuggestion(
    pageId: string,
    suggestionId: string,
    routeProjectId?: string,
    authorizedProjectId?: string | { id: string } | null,
    userId?: string,
  ) {
    return this.resolveSingleSuggestion(
      false,
      pageId,
      suggestionId,
      routeProjectId,
      authorizedProjectId,
      userId,
    );
  }

  private async resolveSingleSuggestion(
    isAccept: boolean,
    pageId: string,
    suggestionId: string,
    routeProjectId?: string,
    authorizedProjectId?: string | { id: string } | null,
    userId?: string,
  ) {
    if (!isUuid(suggestionId)) {
      throw new BadRequestException(
        'A valid UUID is required for suggestionId',
      );
    }

    const { docId: resolvedDocId, projectId: targetProjectId } =
      await this.resolveDoc(pageId, routeProjectId || authorizedProjectId);
    if (!targetProjectId || (isAccept && !this.trackChangesRepo)) {
      throw new NotFoundException(`Suggestion ${suggestionId} not found`);
    }

    const existing = await this.reviewScopeRepo.findTrackChangeInProject(
      targetProjectId,
      suggestionId,
      resolvedDocId,
    );
    if (!existing) {
      throw new NotFoundException(`Suggestion ${suggestionId} not found`);
    }

    if (existing.status && existing.status !== 'pending') {
      const userMap = await this.userResolver.resolveUserNames([
        existing.createdById,
        userId,
      ]);
      return {
        ok: true,
        suggestion: {
          ...existing,
          ...formatSuggestionItemDto(existing, userMap),
        },
      };
    }

    const nextStatus = isAccept ? 'accepted' : 'rejected';
    const resolvedById = isUuid(userId) ? userId : null;

    if (typeof this.reviewScopeRepo.claimTrackChangesPending === 'function') {
      const claimed = await this.reviewScopeRepo.claimTrackChangesPending(
        targetProjectId,
        [suggestionId],
        nextStatus,
        resolvedById,
        resolvedDocId,
      );
      if (claimed.length === 0) {
        const latest =
          (await this.reviewScopeRepo.findTrackChangeInProject(
            targetProjectId,
            suggestionId,
          )) ?? existing;
        const userMap = await this.userResolver.resolveUserNames([
          latest.createdById,
          userId,
        ]);
        return {
          ok: true,
          suggestion: {
            ...latest,
            ...formatSuggestionItemDto(latest, userMap),
          },
        };
      }
    } else {
      await this.reviewScopeRepo.updateTrackChangeInProject(
        targetProjectId,
        suggestionId,
        { status: nextStatus, resolvedAt: new Date(), resolvedById },
      );
    }

    const record = await this.reviewScopeRepo.findTrackChangeInProject(
      targetProjectId,
      suggestionId,
    );
    const updatedPage =
      record && record.docId
        ? await applySingleSuggestionDocPatch({
            isAccept,
            targetProjectId,
            suggestionId,
            record,
            nextStatus,
            resolvedById,
            liveCollab: this.liveCollab,
            pageScopeRepo: this.pageScopeRepo,
            reviewScopeRepo: this.reviewScopeRepo,
            pageService: this.pageService,
            docstoreService: this.docstoreService,
            syncLiveDoc: (projId, dId, lines) =>
              this.syncLiveDoc(projId, dId, lines),
            eventEmitter: this.eventEmitter,
            logger: this.logger,
          })
        : null;

    const userMap = await this.userResolver.resolveUserNames([
      record?.createdById,
      userId,
    ]);
    const formatted = record ? formatSuggestionItemDto(record, userMap) : null;
    return {
      ok: true,
      suggestion: record ? { ...record, ...formatted } : null,
      ...(updatedPage ? { page: updatedPage } : {}),
    };
  }

  public async batchResolvePageSuggestions(
    pageId: string,
    authorizedProjectId: string | { id: string } | null,
    isAccept: boolean,
    suggestionIds?: string[],
    userId?: string | null,
  ): Promise<number> {
    const { docId: resolvedDocId, projectId: targetProjectId } =
      await this.resolveDoc(pageId, authorizedProjectId);
    if (!targetProjectId) return 0;

    return executeBatchResolveSuggestions({
      targetProjectId,
      docId: resolvedDocId || pageId,
      isAccept,
      suggestionIds,
      userId,
      trackChangesRepo: this.trackChangesRepo,
      trackChangesService: this.trackChangesService,
      reviewScopeRepo: this.reviewScopeRepo,
      pageScopeRepo: this.pageScopeRepo,
      pageService: this.pageService,
      docstoreService: this.docstoreService,
      liveCollab: this.liveCollab,
      syncLiveDoc: (projId, dId, lines) => this.syncLiveDoc(projId, dId, lines),
      eventEmitter: this.eventEmitter,
    });
  }
}
