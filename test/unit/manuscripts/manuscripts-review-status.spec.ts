import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  UpdateReviewStatusDto,
  isReviewTransitionAllowed,
  REVIEW_STATUSES,
} from '@/modules/manuscripts/docstore/dto/review-status.dto';

describe('Review status lifecycle', () => {
  it('allows the happy path draft -> in_review -> approved -> submitted -> locked', () => {
    expect(isReviewTransitionAllowed('draft', 'in_review')).toBe(true);
    expect(isReviewTransitionAllowed('in_review', 'approved')).toBe(true);
    expect(isReviewTransitionAllowed('approved', 'submitted')).toBe(true);
    expect(isReviewTransitionAllowed('submitted', 'locked')).toBe(true);
  });

  it('rejects skipping states', () => {
    expect(isReviewTransitionAllowed('draft', 'approved')).toBe(false);
    expect(isReviewTransitionAllowed('draft', 'locked')).toBe(false);
    expect(isReviewTransitionAllowed('in_review', 'locked')).toBe(false);
  });

  it('locked can only go back to draft; same-state is idempotent', () => {
    for (const s of REVIEW_STATUSES) {
      if (s !== 'draft' && s !== 'locked') {
        expect(isReviewTransitionAllowed('locked', s)).toBe(false);
      }
    }
    expect(isReviewTransitionAllowed('locked', 'draft')).toBe(true);
    expect(isReviewTransitionAllowed('approved', 'approved')).toBe(true);
  });

  it('DTO validates status, notes length and deadline format', async () => {
    const ok = plainToInstance(UpdateReviewStatusDto, {
      status: 'in_review',
      notes: 'please check',
      deadline: '2026-12-01T00:00:00Z',
    });
    expect(await validate(ok)).toHaveLength(0);

    const bad = plainToInstance(UpdateReviewStatusDto, {
      status: 'bogus',
      notes: 'x'.repeat(2001),
      deadline: 'tomorrow',
    });
    const errors = await validate(bad);
    expect(errors.map((e) => e.property).sort()).toEqual([
      'deadline',
      'notes',
      'status',
    ]);
  });
});
