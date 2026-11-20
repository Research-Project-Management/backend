import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { isUuid } from '@/core';
import { isPrismaUniqueConstraintError } from '@/modules/pages/core/page-scope.helper';
import { PageService } from '@/modules/pages/core/services/page.service';
import { UserResolverService } from '@/modules/pages/core/services/user-resolver.service';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import { ReviewRoundInfo } from '@/modules/pages/docstore/domain';
import { ScopeRepository } from '@/modules/pages/docstore/repositories/scope.repository';
import { Role } from '@/modules/project/access';
import {
  UpdateReviewStatusDto,
  reviewTransitionPolicy,
} from '../dto/status.dto';
import { REVIEW_EVENTS, emitReviewEvent } from '../review.events';
import { ReviewRepository } from '../review.repository';
import {
  resolveReviewTarget,
  toCommentDto,
  toSuggestionDto,
} from './scope.helper';

@Injectable()
export class ReviewStatusService {
  constructor(
    private readonly repo: ReviewRepository,
    private readonly docstoreService: DocstoreService,
    private readonly scopeRepo: ScopeRepository,
    private readonly userResolver: UserResolverService,
    private readonly pageService: PageService,
    @Optional() private readonly eventEmitter?: EventEmitter2,
  ) {}

  private toPersistencePayload(review: ReviewRoundInfo) {
    return {
      status: review.status,
      roundNumber: review.roundNumber ?? 1,
      requestedById: isUuid(review.requestedById) ? review.requestedById : null,
      requestedAt: review.requestedAt ? new Date(review.requestedAt) : null,
      verdictById: isUuid(review.verdictById) ? review.verdictById : null,
      verdictAt: review.verdictAt ? new Date(review.verdictAt) : null,
      notes: review.notes ?? null,
      deadline: review.deadline ? new Date(review.deadline) : null,
    };
  }

  public async getStatus(
    targetId: string,
    routeSpaceId?: string,
    authSpace?: string | { id: string } | null,
  ) {
    const { docId, spaceId } = await resolveReviewTarget({
      scopeRepo: this.scopeRepo,
      pageService: this.pageService,
      targetId,
      authSpace: routeSpaceId || authSpace,
      fallbackPrisma: this.repo.getPrisma(),
    });
    if (!docId || !spaceId) {
      throw new NotFoundException(`Document ${targetId} not found`);
    }

    const row = await this.repo.findDocReview(docId);
    if (row && (!row.spaceId || row.spaceId === spaceId)) {
      const review: ReviewRoundInfo = {
        status: row.status,
        roundNumber: row.roundNumber,
        requestedById: row.requestedById ?? undefined,
        requestedAt: row.requestedAt?.toISOString(),
        verdictById: row.verdictById ?? undefined,
        verdictAt: row.verdictAt?.toISOString(),
        notes: row.notes ?? undefined,
        deadline: row.deadline?.toISOString(),
      };
      return { ok: true, docId, projectId: spaceId, review };
    }

    const doc = await this.docstoreService.getDoc(spaceId, docId);
    const review: ReviewRoundInfo = doc.ranges?.review || {
      status: 'draft',
      roundNumber: 1,
    };
    return { ok: true, docId, projectId: spaceId, review };
  }

  public async updateStatus(
    targetId: string,
    body: UpdateReviewStatusDto,
    authSpace: string | { id: string } | null,
    currentRole: Role,
    routeSpaceId?: string,
    userId?: string,
  ) {
    const { docId, spaceId } = await resolveReviewTarget({
      scopeRepo: this.scopeRepo,
      pageService: this.pageService,
      targetId,
      authSpace: routeSpaceId || authSpace,
      fallbackPrisma: this.repo.getPrisma(),
    });
    if (!docId || !spaceId) {
      throw new NotFoundException(`Document ${targetId} not found`);
    }

    const docRecord = await this.scopeRepo.findDocInProject(spaceId, docId);
    if (!docRecord) {
      throw new NotFoundException(`Document ${targetId} not found`);
    }

    const doc = await this.docstoreService.getDoc(spaceId, docId);
    const legacyReview = doc.ranges?.review;

    const MAX_CAS_ATTEMPTS = 3;
    let prevReview: ReviewRoundInfo = legacyReview || {
      roundNumber: 1,
      status: 'draft',
    };
    let updatedReview: ReviewRoundInfo = prevReview;

    for (let attempt = 1; attempt <= MAX_CAS_ATTEMPTS; attempt++) {
      const existingRow = await this.repo.findDocReview(docId);
      prevReview = existingRow
        ? {
            status: existingRow.status,
            roundNumber: existingRow.roundNumber,
            requestedById: existingRow.requestedById ?? undefined,
            requestedAt: existingRow.requestedAt?.toISOString(),
            verdictById: existingRow.verdictById ?? undefined,
            verdictAt: existingRow.verdictAt?.toISOString(),
            notes: existingRow.notes ?? undefined,
            deadline: existingRow.deadline?.toISOString(),
          }
        : legacyReview || { roundNumber: 1, status: 'draft' };

      const decision = reviewTransitionPolicy.evaluate({
        role: String(currentRole),
        fromStatus: prevReview.status,
        toStatus: body.status,
      });
      if (!decision.allowed) {
        if (decision.violationType === 'forbidden') {
          throw new ForbiddenException(decision.reason);
        }
        throw new BadRequestException(decision.reason);
      }

      const nextRound =
        body.status === 'in_review' && prevReview.status !== 'in_review'
          ? (prevReview.roundNumber || 1) + 1
          : prevReview.roundNumber || 1;
      const nowIso = new Date().toISOString();

      updatedReview = {
        status: body.status,
        roundNumber: nextRound,
        requestedById:
          body.status === 'in_review' ? userId : prevReview.requestedById,
        requestedAt:
          body.status === 'in_review' ? nowIso : prevReview.requestedAt,
        verdictById: ['approved', 'changes_requested'].includes(body.status)
          ? userId
          : prevReview.verdictById,
        verdictAt: ['approved', 'changes_requested'].includes(body.status)
          ? nowIso
          : prevReview.verdictAt,
        notes: body.notes ?? prevReview.notes,
        deadline: body.deadline ?? prevReview.deadline,
      };

      const payload = this.toPersistencePayload(updatedReview);
      if (existingRow) {
        const updated = await this.repo.updateDocReviewCas(
          docId,
          spaceId,
          existingRow.version,
          payload,
        );
        if (!updated) {
          throw new ConflictException(
            `Concurrent review status update conflict for document ${docId}`,
          );
        }
        break;
      }

      try {
        await this.repo.createOrUpsertDocReview(docId, spaceId, payload);
        break;
      } catch (err: unknown) {
        if (isPrismaUniqueConstraintError(err) && attempt < MAX_CAS_ATTEMPTS) {
          continue;
        }
        throw err;
      }
    }

    emitReviewEvent(this.eventEmitter, spaceId, REVIEW_EVENTS.STATUS_CHANGED, {
      docId,
      projectId: spaceId,
      review: updatedReview,
      previousStatus: prevReview.status,
      updatedById: userId,
    });

    return { ok: true, docId, projectId: spaceId, review: updatedReview };
  }

  public async getOverview(
    routeTargetId: string,
    explicitReqPageId?: string,
    authSpace?: string | { id: string } | null,
  ) {
    const resolvedActive = this.pageService.resolveActiveProjectId(authSpace);
    const spaceId =
      resolvedActive ||
      (isUuid(routeTargetId)
        ? (await this.pageService.resolveProjectId(routeTargetId)) ||
          routeTargetId
        : routeTargetId);

    if (!spaceId || !isUuid(spaceId)) {
      return {
        projectId: spaceId || routeTargetId,
        files: [],
        totals: {
          openCommentsCount: 0,
          resolvedCommentsCount: 0,
          pendingSuggestionsCount: 0,
          acceptedSuggestionsCount: 0,
          rejectedSuggestionsCount: 0,
          totalVisibleCount: 0,
          totalResolvedCount: 0,
        },
      };
    }

    const explicitPageId =
      explicitReqPageId ??
      (isUuid(routeTargetId) &&
      resolvedActive &&
      routeTargetId !== resolvedActive
        ? routeTargetId
        : undefined);

    const { docs, nodes, allThreads, allChanges } =
      await this.repo.getOverviewData(spaceId, explicitPageId);

    const userIds: (string | null | undefined)[] = [];
    for (const t of allThreads) {
      userIds.push(t.createdById);
      for (const r of t.replies || []) userIds.push(r.createdById);
    }
    for (const c of allChanges) {
      userIds.push(c.createdById, c.resolvedById);
    }
    const userMap = await this.userResolver.resolveUserNames(userIds);

    const docMetaMap = new Map<
      string,
      { docId: string; title: string; path: string; isRootDoc: boolean }
    >();
    for (const node of nodes) {
      const dId = node.docId || node.id;
      const cleanTitle = (node.path || node.name || 'document.tex').replace(
        /^\/+/,
        '',
      );
      const nodeCompat = node as {
        page?: { rootDocId?: string | null } | null;
        isRootDoc?: boolean;
      };
      const isRootDoc = Boolean(
        nodeCompat.page?.rootDocId
          ? node.docId && node.docId === nodeCompat.page.rootDocId
          : nodeCompat.isRootDoc,
      );
      docMetaMap.set(dId, {
        docId: dId,
        title: cleanTitle,
        path: node.path || `/${cleanTitle}`,
        isRootDoc,
      });
    }
    for (const doc of docs) {
      if (!docMetaMap.has(doc.id)) {
        const docPath = doc.lastKnownPath ?? 'document.tex';
        const cleanTitle = docPath.replace(/^\/+/, '');
        docMetaMap.set(doc.id, {
          docId: doc.id,
          title: cleanTitle,
          path: docPath.startsWith('/') ? docPath : `/${cleanTitle}`,
          isRootDoc: cleanTitle === 'main.tex',
        });
      }
    }

    const threadsByDoc = new Map<string, ReturnType<typeof toCommentDto>[]>();
    for (const t of allThreads) {
      const list = threadsByDoc.get(t.docId) || [];
      list.push(
        toCommentDto(t, userMap, { includeAvatar: true, includeDocId: true }),
      );
      threadsByDoc.set(t.docId, list);
    }

    const changesByDoc = new Map<
      string,
      ReturnType<typeof toSuggestionDto>[]
    >();
    for (const c of allChanges) {
      const list = changesByDoc.get(c.docId) || [];
      list.push(toSuggestionDto(c, userMap));
      changesByDoc.set(c.docId, list);
    }

    for (const dId of [...threadsByDoc.keys(), ...changesByDoc.keys()]) {
      if (!docMetaMap.has(dId)) {
        docMetaMap.set(dId, {
          docId: dId,
          title: 'document.tex',
          path: '/document.tex',
          isRootDoc: false,
        });
      }
    }

    let totalOpenComments = 0;
    let totalResolvedComments = 0;
    let totalPendingSuggestions = 0;
    let totalAcceptedSuggestions = 0;
    let totalRejectedSuggestions = 0;

    const files = Array.from(docMetaMap.values()).map((meta) => {
      const comments = threadsByDoc.get(meta.docId) || [];
      const suggestions = changesByDoc.get(meta.docId) || [];
      const openCommentsCount = comments.filter(
        (c) => c.status !== 'resolved',
      ).length;
      const resolvedCommentsCount = comments.length - openCommentsCount;
      const pendingSuggestionsCount = suggestions.filter(
        (s) => s.status === 'pending',
      ).length;
      const acceptedSuggestionsCount = suggestions.filter(
        (s) => s.status === 'accepted',
      ).length;
      const rejectedSuggestionsCount = suggestions.filter(
        (s) => s.status === 'rejected',
      ).length;

      totalOpenComments += openCommentsCount;
      totalResolvedComments += resolvedCommentsCount;
      totalPendingSuggestions += pendingSuggestionsCount;
      totalAcceptedSuggestions += acceptedSuggestionsCount;
      totalRejectedSuggestions += rejectedSuggestionsCount;

      return {
        docId: meta.docId,
        fileId: meta.docId,
        title: meta.title,
        path: meta.path,
        isRootDoc: meta.isRootDoc,
        comments,
        suggestions,
        counts: {
          openCommentsCount,
          resolvedCommentsCount,
          pendingSuggestionsCount,
          acceptedSuggestionsCount,
          rejectedSuggestionsCount,
          totalVisibleCount: openCommentsCount + pendingSuggestionsCount,
          totalResolvedCount:
            resolvedCommentsCount +
            acceptedSuggestionsCount +
            rejectedSuggestionsCount,
        },
      };
    });

    return {
      projectId: spaceId,
      files,
      totals: {
        openCommentsCount: totalOpenComments,
        resolvedCommentsCount: totalResolvedComments,
        pendingSuggestionsCount: totalPendingSuggestions,
        acceptedSuggestionsCount: totalAcceptedSuggestions,
        rejectedSuggestionsCount: totalRejectedSuggestions,
        totalVisibleCount: totalOpenComments + totalPendingSuggestions,
        totalResolvedCount:
          totalResolvedComments +
          totalAcceptedSuggestions +
          totalRejectedSuggestions,
      },
    };
  }
}
