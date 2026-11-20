import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PageChangeType } from '@prisma/client';
import { AuthenticatedRequest, isUuid } from '@/core';
import { PageService } from '@/modules/pages/core/services/page.service';
import { UserResolverService } from '@/modules/pages/core/services/user-resolver.service';
import { ScopeRepository } from '@/modules/pages/docstore/repositories/scope.repository';
import { DocPatcher } from '../doc-patcher.adapter';
import {
  LinePatcher,
  PatchConflictError,
  StaleAnchorError,
  TextRange,
  TrackChange,
} from '../domain';
import { REVIEW_EVENTS, emitReviewEvent } from '../review.events';
import { ReviewMapper, ReviewRepository } from '../review.repository';
import {
  resolveReviewTarget,
  toSuggestionDto,
  validateSuggestionRange,
} from './scope.helper';

export interface CreateSuggestionInput {
  type?: string;
  suggestedText?: string;
  originalText?: string;
  fromLine?: number;
  fromColumn?: number;
  toLine?: number;
  toColumn?: number;
  spaceId?: string;
}

@Injectable()
export class SuggestionsService {
  private readonly logger = new Logger(SuggestionsService.name);

  constructor(
    private readonly repo: ReviewRepository,
    private readonly docPatcher: DocPatcher,
    private readonly scopeRepo: ScopeRepository,
    private readonly userResolver: UserResolverService,
    private readonly pageService: PageService,
    @Optional() private readonly eventEmitter?: EventEmitter2,
  ) {}

  private resolveTarget(
    targetId: string,
    authSpace?: string | { id: string } | null,
  ) {
    return resolveReviewTarget({
      scopeRepo: this.scopeRepo,
      pageService: this.pageService,
      targetId,
      authSpace,
      fallbackPrisma: this.repo.getPrisma(),
    });
  }

  private mapPatchError(err: unknown): never {
    if (err instanceof StaleAnchorError || err instanceof PatchConflictError) {
      throw new ConflictException({
        statusCode: 409,
        code: err.code,
        message: err.message,
      });
    }
    throw err;
  }

  public async list(
    targetId: string,
    status?: 'pending' | 'accepted' | 'rejected',
    routeSpaceId?: string,
    authSpace?: string | { id: string } | null,
  ) {
    if (!isUuid(targetId)) return { suggestions: [] };
    try {
      const { docId, spaceId: resolvedSpace } = await this.resolveTarget(
        targetId,
        routeSpaceId || authSpace,
      );
      const spaceId =
        resolvedSpace ||
        this.pageService.resolveActiveProjectId(authSpace) ||
        routeSpaceId;
      const docTargetId = docId || targetId;
      if (!spaceId) return { suggestions: [] };

      const changes = await this.repo.listChanges(spaceId, docTargetId, status);
      const userMap = await this.userResolver.resolveUserNames(
        changes.map((c) => c.createdById),
      );
      return {
        suggestions: changes.map((c) => toSuggestionDto(c, userMap)),
      };
    } catch (err: unknown) {
      this.logger.warn(
        `Failed to list suggestions for ${targetId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { suggestions: [] };
    }
  }

  public async create(
    targetId: string,
    body: CreateSuggestionInput,
    req: AuthenticatedRequest,
    routeSpaceId?: string,
    authSpace?: string | { id: string } | null,
  ) {
    const userId = req?.user?.id || req?.user?.sub || null;
    const activeSpace =
      this.pageService.resolveActiveProjectId(authSpace) || routeSpaceId;
    const {
      docId,
      spaceId: docSpaceId,
      pageId,
    } = await this.resolveTarget(targetId, activeSpace || body?.spaceId);
    const spaceId =
      docSpaceId ||
      activeSpace ||
      body?.spaceId ||
      (await this.pageService.resolveProjectId(targetId));
    const docTargetId = docId || targetId;
    if (!spaceId || !isUuid(spaceId) || !isUuid(docTargetId)) {
      throw new BadRequestException(
        'Valid pageId and associated project required to create a suggestion',
      );
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
    const saved = await this.repo.saveChange(
      TrackChange.create({
        spaceId,
        pageId: pageId ?? null,
        docId: docTargetId,
        type: type === PageChangeType.delete ? 'delete' : 'insert',
        text,
        range: TextRange.create({ startLine, startCol, endLine, endCol }),
        createdById: isUuid(userId) ? userId : null,
      }),
    );

    const suggestion = {
      id: saved.id,
      pageId: docTargetId,
      page: docTargetId,
      projectPageId: docTargetId,
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

    emitReviewEvent(
      this.eventEmitter,
      spaceId,
      REVIEW_EVENTS.SUGGESTION_CREATED,
      { docId: docTargetId, suggestion },
    );

    return { suggestion };
  }

  public accept(
    targetId: string,
    suggestionId: string,
    routeSpaceId?: string,
    authSpace?: string | { id: string } | null,
    userId?: string,
  ) {
    return this.resolveSingle(
      true,
      targetId,
      suggestionId,
      routeSpaceId,
      authSpace,
      userId,
    );
  }

  public reject(
    targetId: string,
    suggestionId: string,
    routeSpaceId?: string,
    authSpace?: string | { id: string } | null,
    userId?: string,
  ) {
    return this.resolveSingle(
      false,
      targetId,
      suggestionId,
      routeSpaceId,
      authSpace,
      userId,
    );
  }

  private async resolveSingle(
    isAccept: boolean,
    targetId: string,
    suggestionId: string,
    routeSpaceId?: string,
    authSpace?: string | { id: string } | null,
    userId?: string,
  ) {
    if (!isUuid(suggestionId)) {
      throw new BadRequestException(
        'A valid UUID is required for suggestionId',
      );
    }

    const { docId, spaceId } = await this.resolveTarget(
      targetId,
      routeSpaceId || authSpace,
    );
    if (!spaceId) {
      throw new NotFoundException(`Suggestion ${suggestionId} not found`);
    }

    const existing = await this.repo.findChange(spaceId, suggestionId, docId);
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
          ...toSuggestionDto(existing, userMap),
        },
      };
    }

    const nextStatus = isAccept ? 'accepted' : 'rejected';
    const resolvedById = isUuid(userId) ? userId : null;
    const claimed = await this.repo.claimPendingChanges(
      spaceId,
      [suggestionId],
      nextStatus,
      resolvedById,
      docId,
    );

    if (claimed.length === 0) {
      const latest =
        (await this.repo.findChange(spaceId, suggestionId)) ?? existing;
      const userMap = await this.userResolver.resolveUserNames([
        latest.createdById,
        userId,
      ]);
      return {
        ok: true,
        suggestion: {
          ...latest,
          ...toSuggestionDto(latest, userMap),
        },
      };
    }

    const record =
      (await this.repo.findChange(spaceId, suggestionId)) ?? existing;
    const domainChange = ReviewMapper.toDomainChange(record);

    let updatedPage: {
      id: string;
      content: string;
      version: number;
      rev: number;
      projectId: string;
    } | null = null;
    let broadcastSpaceId = spaceId;

    try {
      const patchOutcome = isAccept
        ? await this.docPatcher.applyChange(spaceId, record.docId, domainChange)
        : await this.docPatcher.revertChange(
            spaceId,
            record.docId,
            domainChange,
          );

      if (patchOutcome) {
        broadcastSpaceId = patchOutcome.spaceId;
        updatedPage = {
          id: record.docId,
          content: patchOutcome.lines.join('\n'),
          version: patchOutcome.version,
          rev: patchOutcome.rev,
          projectId: patchOutcome.spaceId,
        };
      }
    } catch (err: unknown) {
      this.logger.error(
        `Failed to ${isAccept ? 'apply accepted' : 'revert rejected'} suggestion ${suggestionId}, rolling back claim: ${err}`,
      );
      await this.repo
        .revertClaimedChanges(spaceId, [suggestionId], nextStatus)
        .catch(() => undefined);
      this.mapPatchError(err);
    }

    emitReviewEvent(
      this.eventEmitter,
      broadcastSpaceId,
      REVIEW_EVENTS.SUGGESTION_RESOLVED,
      {
        docId: record.docId,
        change: record,
        action: nextStatus,
        resolvedById,
      },
    );

    const userMap = await this.userResolver.resolveUserNames([
      record.createdById,
      userId,
    ]);
    return {
      ok: true,
      suggestion: { ...record, ...toSuggestionDto(record, userMap) },
      ...(updatedPage ? { page: updatedPage } : {}),
    };
  }

  public async batchResolve(
    targetId: string,
    authSpace: string | { id: string } | null,
    isAccept: boolean,
    suggestionIds?: string[],
    userId?: string | null,
  ): Promise<number> {
    const { docId, spaceId } = await this.resolveTarget(targetId, authSpace);
    if (!spaceId) return 0;
    const targetDocId = docId || targetId;

    const pending = await this.repo.listChanges(
      spaceId,
      targetDocId,
      'pending',
    );
    const filtered =
      suggestionIds && suggestionIds.length > 0
        ? pending.filter((c) => suggestionIds.includes(c.id))
        : pending;
    if (filtered.length === 0) return 0;

    const resolvedStatus = isAccept ? 'accepted' : 'rejected';
    const resolvedById = isUuid(userId) ? userId : null;
    const claimedIds = await this.repo.claimPendingChanges(
      spaceId,
      filtered.map((c) => c.id),
      resolvedStatus,
      resolvedById,
      targetDocId,
    );
    if (claimedIds.length === 0) return 0;

    const claimedSet = new Set(claimedIds);
    const sorted = LinePatcher.sortChangesBottomUp(
      filtered.filter((c) => claimedSet.has(c.id)),
    );

    try {
      await this.docPatcher.applyBatch(spaceId, targetDocId, sorted, isAccept);
    } catch (err: unknown) {
      await this.repo
        .revertClaimedChanges(spaceId, claimedIds, resolvedStatus)
        .catch(() => undefined);
      this.mapPatchError(err);
    }

    emitReviewEvent(
      this.eventEmitter,
      spaceId,
      REVIEW_EVENTS.SUGGESTION_RESOLVED,
      {
        docId: targetDocId,
        changeIds: sorted.map((c) => c.id),
        action: resolvedStatus,
        resolvedById,
      },
    );

    return sorted.length;
  }
}
