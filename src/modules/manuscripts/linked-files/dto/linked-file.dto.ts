/**
 * linked-files/dto/linked-file.dto.ts
 * Data Transfer Objects for Linked Files endpoints (Overleaf parity).
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEnum,
  IsBoolean,
  IsUUID,
} from 'class-validator';
import { LinkedFileProvider } from '../core/domain/entities/linked-file.entity';

export class CreateLinkedFileDto {
  @ApiProperty({
    description:
      'Desired target filename in the file tree (e.g. dataset.csv, references.bib)',
  })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiProperty({ enum: ['url', 'zotero', 'mendeley'], default: 'url' })
  @IsEnum(['url', 'zotero', 'mendeley'])
  provider!: LinkedFileProvider;

  @ApiPropertyOptional({
    description: 'External URL for URL-based linked files',
  })
  @IsString()
  @IsOptional()
  url?: string;

  @ApiPropertyOptional({ description: 'Zotero or Mendeley collection ID' })
  @IsString()
  @IsOptional()
  collectionId?: string;

  @ApiPropertyOptional({
    description: 'Target destination parent folder in the project tree',
  })
  @IsUUID()
  @IsOptional()
  parentFolderId?: string;

  @ApiPropertyOptional({
    description: 'Enable background auto-refresh',
    default: false,
  })
  @IsBoolean()
  @IsOptional()
  autoRefresh?: boolean;
}

export class LinkedFileResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  projectId!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ enum: ['url', 'zotero', 'mendeley'] })
  provider!: string;

  @ApiPropertyOptional()
  url?: string | null;

  @ApiPropertyOptional()
  collectionId?: string | null;

  @ApiPropertyOptional()
  nodeId?: string | null;

  @ApiPropertyOptional()
  docId?: string | null;

  @ApiPropertyOptional()
  fileId?: string | null;

  @ApiProperty({ enum: ['synced', 'failed', 'pending'] })
  status!: string;

  @ApiPropertyOptional()
  lastSyncedAt?: string | null;

  @ApiPropertyOptional()
  errorMessage?: string | null;

  @ApiProperty()
  autoRefresh!: boolean;

  @ApiProperty()
  createdAt!: string;

  @ApiProperty()
  updatedAt!: string;
}
