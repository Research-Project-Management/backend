import {
  IsOptional,
  IsString,
  IsInt,
  IsBoolean,
  Min,
  Max,
  Matches,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class SyncQueryDto {
  @ApiPropertyOptional({
    description:
      'Fetch changes or tombstones with sequence strictly greater than this value',
    default: '0',
    example: '100',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/, {
    message: 'since sequence must be a numeric integer string',
  })
  since?: string;

  @ApiPropertyOptional({
    description: 'Maximum number of delta records to return (1-500)',
    default: 100,
    example: 100,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number = 100;

  @ApiPropertyOptional({
    description:
      'Whether to run sliding-window compaction to squash redundant intermediate mutations',
    default: true,
    example: true,
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === null || value === '') return true;
    if (typeof value === 'boolean') return value;
    const normalized = String(value).trim().toLowerCase();
    return normalized !== 'false' && normalized !== '0';
  })
  @IsBoolean()
  compact?: boolean = true;
}
