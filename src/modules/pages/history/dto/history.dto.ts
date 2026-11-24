/**
 * project-history/dto/history.dto.ts
 * Request & Response Data Transfer Objects for Manuscripts Project History.
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsBoolean,
  IsInt,
  Min,
  MaxLength,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { FileDiffVo } from '../domain/ports';

export class CreateSnapshotDto {
  @ApiPropertyOptional({
    description: 'Optional human-readable summary of this version',
  })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  summary?: string;

  @ApiPropertyOptional({
    description: 'Whether snapshot was triggered automatically by system',
  })
  @IsBoolean()
  @IsOptional()
  isAutomatic?: boolean;

  @ApiPropertyOptional({
    description: 'Optional named label to attach to this version',
  })
  @IsString()
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MaxLength(255)
  label?: string;

  @ApiPropertyOptional({ description: 'Target Page ID scope' })
  @IsString()
  @IsOptional()
  pageId?: string;
}

export class LabelVersionDto {
  @ApiProperty({
    description: 'Named tag or milestone label (e.g. "v1.0-submission")',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  label!: string;

  @ApiPropertyOptional({ description: 'Target Page ID scope' })
  @IsString()
  @IsOptional()
  pageId?: string;
}

export class RestoreVersionDto {
  @ApiProperty({ description: 'Historical version number to restore from' })
  @IsInt()
  @Min(1)
  @Type(() => Number)
  targetVersion!: number;

  @ApiPropertyOptional({ description: 'Target Page ID scope' })
  @IsString()
  @IsOptional()
  pageId?: string;
}

export class RestoreSingleFileDto {
  @ApiProperty({
    description: 'Relative path of the file in the version snapshot to restore',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  pathname!: string;

  @ApiPropertyOptional({
    description: 'Optional document or file identifier hint',
  })
  @IsString()
  @IsOptional()
  fileId?: string;

  @ApiPropertyOptional({ description: 'Target Page ID scope' })
  @IsString()
  @IsOptional()
  pageId?: string;
}

export class RestoreSingleFileResponseDto {
  @ApiProperty()
  path!: string;

  @ApiProperty()
  version!: number;

  @ApiProperty()
  newVersion!: number;

  @ApiPropertyOptional({ nullable: true })
  docId?: string | null;

  @ApiPropertyOptional({ nullable: true })
  fileId?: string | null;

  @ApiPropertyOptional()
  content?: string;

  @ApiPropertyOptional()
  rev?: number;
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

export class VersionAuthorDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiPropertyOptional()
  avatar?: string;
}

export class VersionListItemDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  projectId!: string;

  @ApiPropertyOptional()
  spaceId?: string;

  @ApiPropertyOptional()
  pageId?: string;

  @ApiProperty()
  version!: number;

  @ApiPropertyOptional()
  summary?: string | null;

  @ApiPropertyOptional()
  createdById?: string | null;

  @ApiPropertyOptional({ type: VersionAuthorDto })
  author?: VersionAuthorDto | null;

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
  @ApiProperty({
    description: 'Full dictionary of file snapshots indexed by path',
  })
  files!: Record<string, unknown>;
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

  @ApiProperty({
    description:
      'List of file-level diff results with line hunks and word highlights',
  })
  files!: FileDiffVo[];
}
