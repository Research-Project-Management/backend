import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { REVIEW_STATUSES, type ReviewStatus } from '../domain';

export {
  REVIEW_STATUSES,
  REVIEW_TRANSITIONS,
  ReviewTransitionPolicy,
  isReviewTransitionAllowed,
  reviewTransitionPolicy,
  type ReviewPolicySpec,
  type ReviewStatus,
  type ReviewTransitionCandidate,
} from '../domain';

export class UpdateReviewStatusDto {
  @ApiProperty({ enum: REVIEW_STATUSES })
  @IsIn(REVIEW_STATUSES)
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
