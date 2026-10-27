/**
 * modules/manuscripts/docstore/dto/review-status.dto.ts
 * Request DTO and transition table for the manuscript review lifecycle.
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';
import type { ReviewRoundInfo } from '../domain';

export const REVIEW_STATUSES = [
  'draft',
  'in_review',
  'changes_requested',
  'approved',
  'submitted',
  'locked',
] as const;

export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/** Allowed next states per current state (same-state updates are idempotent). */
export const REVIEW_TRANSITIONS: Record<ReviewStatus, readonly ReviewStatus[]> = {
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
  return REVIEW_TRANSITIONS[from as ReviewStatus]?.includes(to) ?? false;
}

export interface ReviewTransitionCandidate {
  role: string;
  fromStatus: ReviewRoundInfo['status'];
  toStatus: ReviewStatus;
}

export interface IReviewPolicySpec {
  isSatisfiedBy(candidate: ReviewTransitionCandidate): boolean;
  readonly violationReason: (candidate: ReviewTransitionCandidate) => string;
  readonly violationType: 'forbidden' | 'bad_request';
}

/**
 * Specification / Policy Pattern for Manuscript Review Lifecycle transitions.
 * Composes role authorization rules (`OWNER`, `COORDINATOR`, `CONTRIBUTOR`) and
 * state-machine transition rules into a single testable policy object.
 */
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

  private readonly specs: ReadonlyArray<IReviewPolicySpec> = [
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

export const defaultReviewTransitionPolicy = new ReviewTransitionPolicy();

export class UpdateReviewStatusDto {
  @ApiProperty({ enum: REVIEW_STATUSES })
  @IsIn(REVIEW_STATUSES as unknown as string[])
  status!: ReviewStatus;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @ApiPropertyOptional({ description: 'ISO-8601 deadline' })
  @IsOptional()
  @IsISO8601()
  deadline?: string;
}
