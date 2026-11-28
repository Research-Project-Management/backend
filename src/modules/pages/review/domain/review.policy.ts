import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { ReviewRoundInfo } from '@/modules/pages/docstore/domain/doc-range';
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

export const REVIEW_TRANSITIONS: Record<ReviewStatus, readonly ReviewStatus[]> =
  {
    draft: ['in_review'],
    in_review: ['changes_requested', 'approved', 'draft'],
    changes_requested: ['in_review', 'draft'],
    approved: ['submitted', 'in_review', 'draft'],
    submitted: ['locked', 'in_review', 'draft'],
    locked: ['draft'],
  };

export function isReviewTransitionAllowed(
  from: ReviewRoundInfo['status'],
  to: ReviewStatus,
): boolean {
  if (from === to) return true;
  return REVIEW_TRANSITIONS[from]?.includes(to) ?? false;
}

export interface ReviewTransitionCandidate {
  role: string;
  fromStatus: ReviewRoundInfo['status'];
  toStatus: ReviewStatus;
}

export interface ReviewPolicySpec {
  isSatisfiedBy(candidate: ReviewTransitionCandidate): boolean;
  readonly violationReason: (candidate: ReviewTransitionCandidate) => string;
  readonly violationType: 'forbidden' | 'bad_request';
}

export class ReviewTransitionPolicy {
  private static readonly PRIVILEGED_ROLES = new Set(['owner', 'coordinator']);
  private static readonly CONTRIBUTOR_OR_ABOVE = new Set([
    'owner',
    'coordinator',
    'contributor',
  ]);
  private static readonly PRIVILEGED_TARGET_STATUSES = new Set<ReviewStatus>([
    'draft',
    'submitted',
    'locked',
  ]);

  private static normalizeRole(role: string): string {
    return (role || '').trim().toLowerCase();
  }

  private readonly specs: ReadonlyArray<ReviewPolicySpec> = [
    {
      violationType: 'forbidden',
      isSatisfiedBy: ({ role, toStatus }) =>
        !ReviewTransitionPolicy.PRIVILEGED_TARGET_STATUSES.has(toStatus) ||
        ReviewTransitionPolicy.PRIVILEGED_ROLES.has(
          ReviewTransitionPolicy.normalizeRole(role),
        ),
      violationReason: () =>
        'Only project owner or coordinator can set status to draft, submitted, or locked',
    },
    {
      violationType: 'forbidden',
      isSatisfiedBy: ({ role, toStatus }) =>
        toStatus !== 'in_review' ||
        ReviewTransitionPolicy.CONTRIBUTOR_OR_ABOVE.has(
          ReviewTransitionPolicy.normalizeRole(role),
        ),
      violationReason: () =>
        'Only project contributors or owners can request review',
    },
    {
      violationType: 'forbidden',
      isSatisfiedBy: ({ role, fromStatus }) =>
        fromStatus !== 'locked' ||
        ReviewTransitionPolicy.PRIVILEGED_ROLES.has(
          ReviewTransitionPolicy.normalizeRole(role),
        ),
      violationReason: () =>
        'Document review is locked; only owner or coordinator can change it',
    },
    {
      violationType: 'bad_request',
      isSatisfiedBy: ({ fromStatus, toStatus }) =>
        isReviewTransitionAllowed(fromStatus, toStatus),
      violationReason: ({ fromStatus, toStatus }) =>
        `Invalid review transition: ${fromStatus} -> ${toStatus}`,
    },
  ];

  public evaluate(candidate: ReviewTransitionCandidate): {
    allowed: boolean;
    violationType?: 'forbidden' | 'bad_request';
    reason?: string;
  } {
    for (const spec of this.specs) {
      if (!spec.isSatisfiedBy(candidate)) {
        return {
          allowed: false,
          violationType: spec.violationType,
          reason: spec.violationReason(candidate),
        };
      }
    }
    return { allowed: true };
  }
}

export const reviewTransitionPolicy = new ReviewTransitionPolicy();

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
