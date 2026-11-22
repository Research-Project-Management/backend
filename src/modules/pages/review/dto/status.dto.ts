import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { REVIEW_STATUSES, type ReviewStatus } from '../domain/review.policy';

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
