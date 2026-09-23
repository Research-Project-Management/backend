/**
 * project-history/dto/history.dto.ts
 * Request & Response Data Transfer Objects for Manuscripts Project History.
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsBoolean, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateSnapshotDto {
  @ApiPropertyOptional({ description: 'Optional human-readable summary of this version' })
  @IsString()
  @IsOptional()
  summary?: string;

  @ApiPropertyOptional({ description: 'Whether snapshot was triggered automatically by system' })
  @IsBoolean()
  @IsOptional()
  isAutomatic?: boolean;

  @ApiPropertyOptional({ description: 'Optional named label to attach to this version' })
  @IsString()
  @IsOptional()
  label?: string;
}

export class LabelVersionDto {
  @ApiProperty({ description: 'Named tag or milestone label (e.g. "v1.0-submission")' })
  @IsString()
  @IsNotEmpty()
  label!: string;
}

export class RestoreVersionDto {
  @ApiProperty({ description: 'Historical version number to restore from' })
  @IsInt()
  @Min(1)
  @Type(() => Number)
  targetVersion!: number;
}

export class VersionLabelDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  version!: number;

  @ApiProperty()
  label!: string;

  @ApiPropertyOptional()
  createdById?: string | null;

  @ApiProperty()
  createdAt!: Date;
}

export class VersionListItemDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  projectId!: string;

  @ApiProperty()
  version!: number;

  @ApiPropertyOptional()
  summary?: string | null;

  @ApiPropertyOptional()
  createdById?: string | null;

  @ApiProperty()
  isAutomatic!: boolean;

  @ApiProperty()
  fileCount!: number;

  @ApiProperty({ type: [VersionLabelDto] })
  labels!: VersionLabelDto[];

  @ApiProperty()
  createdAt!: Date;
}

export class SnapshotDetailDto extends VersionListItemDto {
  @ApiProperty({ description: 'Full dictionary of file snapshots indexed by path' })
  files!: Record<string, any>;
}

export class DiffQueryDto {
  @ApiProperty({ description: 'Base baseline version number' })
  @IsInt()
  @Min(1)
  @Type(() => Number)
  baseVersion!: number;

  @ApiProperty({ description: 'Target comparison version number' })
  @IsInt()
  @Min(1)
  @Type(() => Number)
  targetVersion!: number;
}

export class DiffResponseDto {
  @ApiProperty()
  baseVersion!: number;

  @ApiProperty()
  targetVersion!: number;

  @ApiProperty()
  totalAdditions!: number;

  @ApiProperty()
  totalDeletions!: number;

  @ApiProperty()
  filesChanged!: number;

  @ApiProperty({ description: 'List of file-level diff results with line hunks and word highlights' })
  files!: any[];
}
