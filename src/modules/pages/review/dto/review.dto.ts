import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateCommentDto {
  @ApiProperty()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(10000)
  content!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  line?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  lineEnd?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  anchorStart?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  anchorEnd?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  baseDocRev?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  spaceId?: string;
}

export class UpdateCommentDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(10000)
  content?: string;

  @ApiPropertyOptional({ enum: ['open', 'resolved'] })
  @IsOptional()
  @IsIn(['open', 'resolved'])
  status?: 'open' | 'resolved';

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  resolved?: boolean;
}

export class ReplyDto {
  @ApiProperty()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(10000)
  content!: string;
}

export class ResolveCommentDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  resolved?: boolean;
}

export class CreateSuggestionDto {
  @ApiPropertyOptional({ enum: ['insert', 'delete'] })
  @IsOptional()
  @IsIn(['insert', 'delete'])
  type?: 'insert' | 'delete';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50000)
  suggestedText?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50000)
  originalText?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  fromLine?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  fromColumn?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  toLine?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  toColumn?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  groupId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  anchorStart?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  anchorEnd?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  baseDocRev?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  spaceId?: string;
}

export class BatchResolveDto {
  @ApiProperty({ enum: ['accept', 'reject', 'accept_all', 'reject_all'] })
  @IsIn(['accept', 'reject', 'accept_all', 'reject_all'])
  action!: 'accept' | 'reject' | 'accept_all' | 'reject_all';

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  suggestionIds?: string[];
}
