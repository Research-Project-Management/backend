import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsBoolean,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { VersionLabelDto } from './label.dto';

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
