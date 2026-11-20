/**
 * modules/pages/track-changes/services/review-status.helper.ts
 * Review lifecycle status CAS persistence and project-wide review overview aggregation.
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { PageReviewStatus } from '@prisma/client';
import { PrismaService, isUuid } from '@/core';
import { isPrismaUniqueConstraintError } from '@/modules/pages/core/page-scope.helper';
import { Role } from '@/modules/project/access';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import { DocRanges, ReviewRoundInfo } from '@/modules/pages/docstore/domain';
import {
  UpdateReviewStatusDto,
  defaultReviewTransitionPolicy,
} from '../dto/review-status.dto';
import { ReviewScopeRepository } from '../repositories/review-scope.repository';
import {
  type ResolvedUserMap,
  formatCommentThreadDto,
  formatSuggestionItemDto,
} from './review.helpers';

export async function getDocReviewStatusWithFallback(
  prisma: PrismaService,
  docstoreService: DocstoreService,
  projectId: string,
  docId: string,
): Promise<ReviewRoundInfo> {
  if (prisma?.pageDocReview?.findUnique) {
    const row = await prisma.pageDocReview
      .findUnique({ where: { docId } })
      .catch(() => null);
    const rowSpaceId =
      row?.spaceId ?? (row as { projectId?: string } | null)?.projectId;
    if (row && (!rowSpaceId || rowSpaceId === projectId)) {
      return {
        status: row.status,
        roundNumber: row.roundNumber,
        requestedById: row.requestedById ?? undefined,
        requestedAt: row.requestedAt
          ? row.requestedAt.toISOString()
          : undefined,
        verdictById: row.verdictById ?? undefined,
        verdictAt: row.verdictAt ? row.verdictAt.toISOString() : undefined,
        notes: row.notes ?? undefined,
        deadline: row.deadline ? row.deadline.toISOString() : undefined,
      };
    }
  }

  const doc = await docstoreService.getDoc(projectId, docId);
  const ranges = doc.ranges || {};
  return (
    ranges.review || {
      status: 'draft',
      roundNumber: 1,
    }
  );
}

function buildReviewPersistencePayload(updatedReview: ReviewRoundInfo) {
  return {
    status: updatedReview.status,
    roundNumber: updatedReview.roundNumber,
    requestedById: isUuid(updatedReview.requestedById)
      ? updatedReview.requestedById
      : null,
    requestedAt: updatedReview.requestedAt
      ? new Date(updatedReview.requestedAt)
      : null,
    verdictById: isUuid(updatedReview.verdictById)
      ? updatedReview.verdictById
      : null,
    verdictAt: updatedReview.verdictAt
      ? new Date(updatedReview.verdictAt)
      : null,
    notes: updatedReview.notes ?? null,
    deadline: updatedReview.deadline ? new Date(updatedReview.deadline) : null,
  };
}

export async function updateDocReviewStatusWithCas(params: {
  prisma: PrismaService;
  docstoreService: DocstoreService;
  projectId: string;
  docId: string;
  body: UpdateReviewStatusDto;
  currentRole: Role;
  userId?: string;
}): Promise<{
  review: ReviewRoundInfo;
  previousStatus: ReviewRoundInfo['status'];
}> {
  const {
    prisma,
    docstoreService,
    projectId,
    docId,
    body,
    currentRole,
    userId,
  } = params;

  const doc = await docstoreService.getDoc(projectId, docId);
  const ranges = doc.ranges || {};

  const MAX_CAS_ATTEMPTS = 3;
  let prevReview: ReviewRoundInfo = ranges.review || {
    roundNumber: 1,
    status: 'draft',
  };
  let updatedReview: ReviewRoundInfo = prevReview;

  for (let attempt = 1; attempt <= MAX_CAS_ATTEMPTS; attempt++) {
    let existingRow: {
      docId: string;
      spaceId?: string;
      projectId?: string;
      status: PageReviewStatus;
      roundNumber: number;
      version: number;
      requestedById: string | null;
      requestedAt: Date | null;
      verdictById: string | null;
      verdictAt: Date | null;
      notes: string | null;
      deadline: Date | null;
    } | null = null;

    if (prisma?.pageDocReview?.findUnique) {
      existingRow = await prisma.pageDocReview
        .findUnique({ where: { docId } })
        .catch(() => null);
    }

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
      : ranges.review || { roundNumber: 1, status: 'draft' };

    const policyDecision = defaultReviewTransitionPolicy.evaluate({
      role: String(currentRole),
      fromStatus: prevReview.status,
      toStatus: body.status,
    });
    if (!policyDecision.allowed) {
      if (policyDecision.violationType === 'forbidden') {
        throw new ForbiddenException(policyDecision.reason);
      }
      throw new BadRequestException(policyDecision.reason);
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

    if (!prisma?.pageDocReview) {
      break;
    }

    const basePayload = buildReviewPersistencePayload(updatedReview);
    if (existingRow) {
      const cas = await prisma.pageDocReview.updateMany({
        where: { docId, spaceId: projectId, version: existingRow.version },
        data: { ...basePayload, version: { increment: 1 } },
      });
      if (cas.count === 0) {
        throw new ConflictException(
          `Concurrent review status update conflict for document ${docId}`,
        );
      }
      break;
    }

    if (!prisma.pageDocReview.create && !prisma.pageDocReview.upsert) {
      break;
    }

    try {
      if (prisma.pageDocReview.create) {
        await prisma.pageDocReview.create({
          data: { docId, spaceId: projectId, version: 1, ...basePayload },
        });
      } else if (prisma.pageDocReview.upsert) {
        await prisma.pageDocReview.upsert({
          where: { docId },
          create: { docId, spaceId: projectId, version: 1, ...basePayload },
          update: { ...basePayload, version: { increment: 1 } },
        });
      }
      break;
    } catch (err: unknown) {
      if (isPrismaUniqueConstraintError(err) && attempt < MAX_CAS_ATTEMPTS) {
        continue;
      }
      throw err;
    }
  }

  const nextRanges: DocRanges = { ...ranges, review: updatedReview };
  await docstoreService.patchDoc(projectId, docId, { ranges: nextRanges });

  return { review: updatedReview, previousStatus: prevReview.status };
}

export async function buildProjectReviewOverview(params: {
  reviewScopeRepo: ReviewScopeRepository;
  projectId: string;
  pageId?: string;
  resolveUserNames: (
    userIds: (string | null | undefined)[],
  ) => Promise<ResolvedUserMap>;
}) {
  const { reviewScopeRepo, projectId, pageId, resolveUserNames } = params;

  const { docs, nodes, allThreads, allChanges } =
    typeof reviewScopeRepo.getProjectReviewOverviewData === 'function'
      ? await reviewScopeRepo.getProjectReviewOverviewData(projectId, pageId)
      : await (async () => {
          const prisma = reviewScopeRepo.getPrisma();
          const pageFilter = pageId ? { pageId } : {};
          const [d, n, t, c] = await Promise.all([
            prisma.pageDoc.findMany({
              where: { spaceId: projectId, ...pageFilter, deletedAt: null },
              select: { id: true, lastKnownPath: true },
              orderBy: { createdAt: 'asc' },
            }),
            prisma.pageNode.findMany({
              where: { spaceId: projectId, ...pageFilter, type: 'DOC' },
              select: {
                id: true,
                docId: true,
                name: true,
                path: true,
                sortOrder: true,
                page: { select: { rootDocId: true } },
              },
              orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
            }),
            prisma.pageCommentThread.findMany({
              where: { spaceId: projectId, ...pageFilter },
              include: { replies: { orderBy: { createdAt: 'asc' } } },
              orderBy: [{ startLine: 'asc' }, { createdAt: 'asc' }],
            }),
            prisma.pageTrackChange.findMany({
              where: { spaceId: projectId, ...pageFilter },
              orderBy: [
                { startLine: 'asc' },
                { startCol: 'asc' },
                { createdAt: 'asc' },
              ],
            }),
          ]);
          return { docs: d, nodes: n, allThreads: t, allChanges: c };
        })();

  const userIds: (string | null | undefined)[] = [];
  for (const t of allThreads) {
    userIds.push(t.createdById);
    for (const r of t.replies || []) userIds.push(r.createdById);
  }
  for (const c of allChanges) {
    userIds.push(c.createdById, c.resolvedById);
  }
  const userMap = await resolveUserNames(userIds);

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
      const docPath =
        (doc as { lastKnownPath?: string; path?: string }).lastKnownPath ??
        (doc as { path?: string }).path ??
        'document.tex';
      const cleanTitle = docPath.replace(/^\/+/, '');
      docMetaMap.set(doc.id, {
        docId: doc.id,
        title: cleanTitle,
        path: docPath.startsWith('/') ? docPath : `/${cleanTitle}`,
        isRootDoc: cleanTitle === 'main.tex',
      });
    }
  }

  const threadsByDoc = new Map<
    string,
    ReturnType<typeof formatCommentThreadDto>[]
  >();
  for (const t of allThreads) {
    const formatted = formatCommentThreadDto(t, userMap, {
      includeAvatar: true,
      includeDocId: true,
    });
    const list = threadsByDoc.get(t.docId) || [];
    list.push(formatted);
    threadsByDoc.set(t.docId, list);
  }

  const changesByDoc = new Map<
    string,
    ReturnType<typeof formatSuggestionItemDto>[]
  >();
  for (const c of allChanges) {
    const formatted = formatSuggestionItemDto(c, userMap);
    const list = changesByDoc.get(c.docId) || [];
    list.push(formatted);
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
    projectId,
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
