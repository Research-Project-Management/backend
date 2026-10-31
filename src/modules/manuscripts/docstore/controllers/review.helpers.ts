/**
 * modules/manuscripts/docstore/controllers/review.helpers.ts
 * Co-located formatting, validation, resolution, and docstore-patching helpers
 * for PagesReviewController.
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  ManuscriptCommentReply,
  ManuscriptCommentThread,
  ManuscriptReviewStatus,
  ManuscriptTrackChange,
} from '@prisma/client';
import { PrismaService, AuthenticatedRequest, isUuid } from '@/core';
import { Role } from '@/modules/project/access';
import { DocstoreService } from '../docstore.service';
import { DocRanges, ReviewRoundInfo } from '../domain';
import {
  UpdateReviewStatusDto,
  isReviewTransitionAllowed,
  defaultReviewTransitionPolicy,
} from '../dto/review-status.dto';
import { ManuscriptPageScopeRepository } from '../repositories/scope.repository';

export type ResolvedUserMap = Map<
  string,
  { id: string; name: string; avatar?: string }
>;

export type ThreadWithReplies = ManuscriptCommentThread & {
  replies?: ManuscriptCommentReply[];
};

export function resolveActiveProjectId(
  project?: string | { id: string } | null,
): string | undefined {
  if (!project) return undefined;
  return typeof project === 'string' ? project : project.id;
}

export function validateCommentRange(
  line?: number,
  lineEnd?: number,
): { startLine: number; endLine: number } {
  const startLine = line ?? 1;
  const endLine = lineEnd ?? startLine;
  if (startLine < 1 || endLine < startLine) {
    throw new BadRequestException(
      'Invalid comment range: startLine must be >= 1 and endLine >= startLine',
    );
  }
  return { startLine, endLine };
}

export function validateSuggestionRange(body: {
  fromLine?: number;
  toLine?: number;
  fromColumn?: number;
  toColumn?: number;
}): {
  startLine: number;
  endLine: number;
  startCol: number;
  endCol: number;
} {
  const startLine = body.fromLine ?? 1;
  const endLine = body.toLine ?? startLine;
  const startCol = body.fromColumn ?? 0;
  const endCol = body.toColumn ?? 0;
  if (startLine < 1 || endLine < startLine || startCol < 0 || endCol < 0) {
    throw new BadRequestException(
      'Invalid suggestion range: startLine >= 1, endLine >= startLine, and columns >= 0 are required',
    );
  }
  return { startLine, endLine, startCol, endCol };
}

export function assertCanModifyReviewItem(
  authorId: string | null | undefined,
  userId: string | null | undefined,
  role: Role | undefined,
  message: string,
): void {
  const isAuthor = authorId === userId;
  const isPrivileged = role === Role.COORDINATOR || role === Role.OWNER;
  if (!isAuthor && !isPrivileged) {
    throw new ForbiddenException({
      statusCode: 403,
      code: 'ROLE_INSUFFICIENT',
      message,
    });
  }
}

export function formatCommentThreadDto(
  t: ThreadWithReplies,
  userMap: ResolvedUserMap,
  options?: { includeAvatar?: boolean; includeDocId?: boolean },
) {
  const threadUser = t.createdById ? userMap.get(t.createdById) : undefined;
  const includeAvatar = options?.includeAvatar ?? false;
  const includeDocId = options?.includeDocId ?? true;

  return {
    id: t.id,
    page: t.docId,
    projectPageId: t.docId,
    ...(includeDocId ? { docId: t.docId } : {}),
    author: {
      id: t.createdById || 'anonymous',
      name: threadUser?.name || 'Collaborator',
      ...(includeAvatar ? { avatar: threadUser?.avatar || '' } : {}),
    },
    content: t.quote || '',
    line: t.startLine,
    lineEnd: t.endLine,
    status: t.isResolved ? 'resolved' : 'open',
    replies: (t.replies || []).map((r) => {
      const replyUser = r.createdById ? userMap.get(r.createdById) : undefined;
      return {
        id: r.id,
        author: {
          id: r.createdById || 'anonymous',
          name: replyUser?.name || 'Collaborator',
          ...(includeAvatar ? { avatar: replyUser?.avatar || '' } : {}),
        },
        content: r.content,
        createdAt: r.createdAt.toISOString(),
      };
    }),
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

export function formatSuggestionItemDto(
  s: ManuscriptTrackChange,
  userMap: ResolvedUserMap,
) {
  const authorUser = s.createdById ? userMap.get(s.createdById) : undefined;
  return {
    id: s.id,
    pageId: s.docId,
    projectPageId: s.docId,
    authorId: s.createdById || 'anonymous',
    author: {
      id: s.createdById || 'anonymous',
      name: authorUser?.name || 'Collaborator',
      email: '',
    },
    type: s.type,
    originalText: s.type === 'delete' ? s.text : '',
    suggestedText: s.type === 'insert' ? s.text : '',
    fromLine: s.startLine,
    fromColumn: s.startCol,
    toLine: s.endLine,
    toColumn: s.endCol,
    description: null,
    status: s.status,
    resolvedById: s.resolvedById,
    resolvedAt: s.resolvedAt ? s.resolvedAt.toISOString() : null,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

export async function getDocReviewStatusWithFallback(
  prisma: PrismaService,
  docstoreService: DocstoreService,
  projectId: string,
  docId: string,
): Promise<ReviewRoundInfo> {
  if (prisma?.manuscriptDocReview?.findUnique) {
    const row = await prisma.manuscriptDocReview
      .findUnique({
        where: { docId },
      })
      .catch(() => null);
    if (row && (!row.projectId || row.projectId === projectId)) {
      return {
        status: row.status,
        roundNumber: row.roundNumber,
        requestedById: row.requestedById ?? undefined,
        requestedAt: row.requestedAt ? row.requestedAt.toISOString() : undefined,
        verdictById: row.verdictById ?? undefined,
        verdictAt: row.verdictAt ? row.verdictAt.toISOString() : undefined,
        notes: row.notes ?? undefined,
        deadline: row.deadline ? row.deadline.toISOString() : undefined,
      };
    }
  }

  const doc = await docstoreService.getDoc(projectId, docId);
  const ranges = (doc.ranges as DocRanges) || {};
  return (
    ranges.review || {
      status: 'draft',
      roundNumber: 1,
    }
  );
}

export async function updateDocReviewStatusWithCas(params: {
  prisma: PrismaService;
  docstoreService: DocstoreService;
  projectId: string;
  docId: string;
  body: UpdateReviewStatusDto;
  currentRole: Role;
  userId?: string;
}): Promise<{ review: ReviewRoundInfo; previousStatus: ReviewRoundInfo['status'] }> {
  const { prisma, docstoreService, projectId, docId, body, currentRole, userId } =
    params;

  const doc = await docstoreService.getDoc(projectId, docId);
  const ranges = (doc.ranges as DocRanges) || {};

  const MAX_CAS_ATTEMPTS = 3;
  let prevReview: ReviewRoundInfo = ranges.review || {
    roundNumber: 1,
    status: 'draft',
  };
  let updatedReview: ReviewRoundInfo = prevReview;

  for (let attempt = 1; attempt <= MAX_CAS_ATTEMPTS; attempt++) {
    let existingRow: {
      docId: string;
      projectId: string;
      status: ManuscriptReviewStatus;
      roundNumber: number;
      version: number;
      requestedById: string | null;
      requestedAt: Date | null;
      verdictById: string | null;
      verdictAt: Date | null;
      notes: string | null;
      deadline: Date | null;
    } | null = null;

    if (prisma?.manuscriptDocReview?.findUnique) {
      existingRow = await prisma.manuscriptDocReview
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

    if (prisma?.manuscriptDocReview) {
      if (existingRow) {
        const cas = await prisma.manuscriptDocReview.updateMany({
          where: {
            docId,
            projectId,
            version: existingRow.version,
          },
          data: {
            status: updatedReview.status as ManuscriptReviewStatus,
            roundNumber: updatedReview.roundNumber,
            version: { increment: 1 },
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
            deadline: updatedReview.deadline
              ? new Date(updatedReview.deadline)
              : null,
          },
        });
        if (cas.count === 0) {
          throw new ConflictException(
            `Concurrent review status update conflict for document ${docId}`,
          );
        }
        break;
      } else if (prisma.manuscriptDocReview.create) {
        try {
          await prisma.manuscriptDocReview.create({
            data: {
              docId,
              projectId,
              status: updatedReview.status as ManuscriptReviewStatus,
              roundNumber: updatedReview.roundNumber,
              version: 1,
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
              deadline: updatedReview.deadline
                ? new Date(updatedReview.deadline)
                : null,
            },
          });
          break;
        } catch (err: unknown) {
          const code = (err as { code?: string })?.code;
          const msg = err instanceof Error ? err.message : String(err);
          if (
            (code === 'P2002' || msg.includes('P2002')) &&
            attempt < MAX_CAS_ATTEMPTS
          ) {
            continue;
          }
          throw err;
        }
      } else if (prisma.manuscriptDocReview.upsert) {
        try {
          await prisma.manuscriptDocReview.upsert({
            where: { docId },
            create: {
              docId,
              projectId,
              status: updatedReview.status as ManuscriptReviewStatus,
              roundNumber: updatedReview.roundNumber,
              version: 1,
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
              deadline: updatedReview.deadline
                ? new Date(updatedReview.deadline)
                : null,
            },
            update: {
              status: updatedReview.status as ManuscriptReviewStatus,
              roundNumber: updatedReview.roundNumber,
              version: { increment: 1 },
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
              deadline: updatedReview.deadline
                ? new Date(updatedReview.deadline)
                : null,
            },
          });
          break;
        } catch (err: unknown) {
          const code = (err as { code?: string })?.code;
          const msg = err instanceof Error ? err.message : String(err);
          if (
            (code === 'P2002' || msg.includes('P2002')) &&
            attempt < MAX_CAS_ATTEMPTS
          ) {
            continue;
          }
          throw err;
        }
      } else {
        break;
      }
    } else {
      break;
    }
  }

  const nextRanges: DocRanges = {
    ...ranges,
    review: updatedReview,
  };

  await docstoreService.patchDoc(projectId, docId, {
    ranges: nextRanges,
  });

  return { review: updatedReview, previousStatus: prevReview.status };
}
