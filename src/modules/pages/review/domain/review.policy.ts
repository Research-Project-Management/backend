import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { ReviewRoundInfo } from '@/modules/pages/docstore';
import { Role } from '@/modules/project/access';

export const REVIEW_STATUSES = [
  'draft',
  'in_review',
  'changes_requested',
  'approved',
  'submitted',
  'locked',
] as const;

export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

const REVIEW_TRANSITIONS: Record<ReviewStatus, readonly ReviewStatus[]> = {
  draft: ['in_review'],
  in_review: ['changes_requested', 'approved', 'draft'],
  changes_requested: ['in_review', 'draft'],
  approved: ['submitted', 'in_review', 'draft'],
  submitted: ['locked', 'in_review', 'draft'],
  locked: ['draft'],
};

const PRIVILEGED_ROLES = new Set(['owner', 'coordinator']);
const CONTRIBUTOR_OR_ABOVE = new Set(['owner', 'coordinator', 'contributor']);
const PRIVILEGED_TARGET_STATUSES = new Set<ReviewStatus>([
  'draft',
  'submitted',
  'locked',
]);

export function assertReviewTransitionAllowed(candidate: {
  role: string;
  fromStatus: ReviewRoundInfo['status'];
  toStatus: ReviewStatus;
}): void {
  const normalizedRole = (candidate.role || '').trim().toLowerCase();
  const { fromStatus, toStatus } = candidate;

  if (
    PRIVILEGED_TARGET_STATUSES.has(toStatus) &&
    !PRIVILEGED_ROLES.has(normalizedRole)
  ) {
    throw new ForbiddenException(
      'Only project owner or coordinator can set status to draft, submitted, or locked',
    );
  }

  if (toStatus === 'in_review' && !CONTRIBUTOR_OR_ABOVE.has(normalizedRole)) {
    throw new ForbiddenException(
      'Only project contributors or owners can request review',
    );
  }

  if (fromStatus === 'locked' && !PRIVILEGED_ROLES.has(normalizedRole)) {
    throw new ForbiddenException(
      'Document review is locked; only owner or coordinator can change it',
    );
  }

  if (
    fromStatus !== toStatus &&
    !(REVIEW_TRANSITIONS[fromStatus]?.includes(toStatus) ?? false)
  ) {
    throw new BadRequestException(
      `Invalid review transition: ${fromStatus} -> ${toStatus}`,
    );
  }
}

export function validateCommentLines(
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
  const fromLine = body.fromLine ?? 1;
  const toLine = body.toLine ?? fromLine;
  const startCol = body.fromColumn ?? 0;
  const endCol = body.toColumn ?? 0;
  if (fromLine < 1 || toLine < fromLine || startCol < 0 || endCol < 0) {
    throw new BadRequestException(
      'Invalid suggestion range: startLine >= 1, endLine >= startLine, and columns >= 0 are required',
    );
  }
  return {
    startLine: fromLine - 1,
    endLine: toLine - 1,
    startCol,
    endCol,
  };
}

export function assertCanModifyItem(
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
