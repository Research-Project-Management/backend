/**
 * track-changes/dto/track-changes.dto.ts
 * Data Transfer Objects for Manuscripts Review Mode (Track Changes & Comments).
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsEnum, IsInt, Min, IsOptional, IsBoolean, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class TextRangeDto {
  @ApiProperty({ description: '0-indexed starting line number' })
  @IsInt()
  @Min(0)
  startLine!: number;

  @ApiProperty({ description: '0-indexed starting column offset' })
  @IsInt()
  @Min(0)
  startCol!: number;

  @ApiProperty({ description: '0-indexed ending line number' })
  @IsInt()
  @Min(0)
  endLine!: number;

  @ApiProperty({ description: '0-indexed ending column offset' })
  @IsInt()
  @Min(0)
  endCol!: number;
}

export class RecordChangeDto {
  @ApiProperty({ enum: ['insert', 'delete'] })
  @IsEnum(['insert', 'delete'])
  type!: 'insert' | 'delete';

  @ApiProperty({ description: 'The text snippet proposed to be inserted or deleted' })
  @IsString()
  @IsNotEmpty()
  text!: string;

  @ApiProperty({ type: TextRangeDto })
  @ValidateNested()
  @Type(() => TextRangeDto)
  range!: TextRangeDto;
}

export class BatchResolveDto {
  @ApiProperty({ enum: ['accept_all', 'reject_all'] })
  @IsEnum(['accept_all', 'reject_all'])
  action!: 'accept_all' | 'reject_all';
}

export class CreateCommentThreadDto {
  @ApiPropertyOptional({ description: 'Original quoted text selection' })
  @IsString()
  @IsOptional()
  quote?: string;

  @ApiProperty({ type: TextRangeDto })
  @ValidateNested()
  @Type(() => TextRangeDto)
  range!: TextRangeDto;

  @ApiProperty({ description: 'Initial comment message content' })
  @IsString()
  @IsNotEmpty()
  content!: string;
}

export class AddCommentReplyDto {
  @ApiProperty({ description: 'Reply message content' })
  @IsString()
  @IsNotEmpty()
  content!: string;
}

export class ResolveThreadDto {
  @ApiProperty({ description: 'True to resolve/close thread, false to reopen' })
  @IsBoolean()
  resolve!: boolean;
}

export class TrackChangeResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  projectId!: string;

  @ApiProperty()
  docId!: string;

  @ApiProperty({ enum: ['insert', 'delete'] })
  type!: string;

  @ApiProperty({ enum: ['pending', 'accepted', 'rejected'] })
  status!: string;

  @ApiProperty()
  text!: string;

  @ApiProperty({ type: TextRangeDto })
  range!: TextRangeDto;

  @ApiPropertyOptional()
  createdById?: string | null;

  @ApiPropertyOptional()
  resolvedById?: string | null;

  @ApiPropertyOptional()
  resolvedAt?: string | null;

  @ApiProperty()
  createdAt!: string;

  @ApiProperty()
  updatedAt!: string;
}

export class CommentReplyResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  threadId!: string;

  @ApiProperty()
  content!: string;

  @ApiPropertyOptional()
  createdById?: string | null;

  @ApiProperty()
  createdAt!: string;

  @ApiProperty()
  updatedAt!: string;
}

export class CommentThreadResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  projectId!: string;

  @ApiProperty()
  docId!: string;

  @ApiPropertyOptional()
  quote?: string | null;

  @ApiProperty({ type: TextRangeDto })
  range!: TextRangeDto;

  @ApiProperty()
  isResolved!: boolean;

  @ApiPropertyOptional()
  createdById?: string | null;

  @ApiPropertyOptional()
  resolvedById?: string | null;

  @ApiPropertyOptional()
  resolvedAt?: string | null;

  @ApiProperty({ type: [CommentReplyResponseDto] })
  replies!: CommentReplyResponseDto[];

  @ApiProperty()
  createdAt!: string;

  @ApiProperty()
  updatedAt!: string;
}

export class DocReviewsResponseDto {
  @ApiProperty({ type: [TrackChangeResponseDto] })
  changes!: TrackChangeResponseDto[];

  @ApiProperty({ type: [CommentThreadResponseDto] })
  threads!: CommentThreadResponseDto[];
}
