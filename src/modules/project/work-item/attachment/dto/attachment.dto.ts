import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EntityType } from '@prisma/client';

export interface PresignedAttachmentResponse {
  signedUrl: string;
  uploadUrl?: string;
  storageKey: string;
  fileUrl: string;
  publicUrl?: string;
  entityType?: EntityType;
  entityId?: string;
}

export class BaseAttachmentMetadataDto {
  @ApiPropertyOptional({ description: 'Storage key in R2 / S3 / local' })
  @IsOptional()
  @IsString()
  storageKey?: string;

  @ApiPropertyOptional({ description: 'Size in bytes', default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  size?: number;

  @ApiPropertyOptional({
    description: 'MIME type',
    default: 'application/octet-stream',
  })
  @IsOptional()
  @IsString()
  mimeType?: string;

  @ApiPropertyOptional({ description: 'Additional custom metadata' })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class CreateAttachmentDto extends BaseAttachmentMetadataDto {
  @ApiProperty({ enum: EntityType, description: 'Entity type' })
  @IsNotEmpty()
  @IsEnum(EntityType)
  entityType!: EntityType;

  @ApiProperty({ description: 'Target entity ID' })
  @IsNotEmpty()
  @IsString()
  entityId!: string;

  @ApiProperty({
    description: 'Original filename',
    example: 'architecture.pdf',
  })
  @IsNotEmpty()
  @IsString()
  filename!: string;

  @ApiProperty({
    description: 'Public URL or streaming path of the attachment',
    example: '/api/v1/storage/files/r2/...',
  })
  @IsNotEmpty()
  @IsString()
  url!: string;

  @ApiPropertyOptional({ description: 'Project ID' })
  @IsOptional()
  @IsString()
  projectId?: string;
}

export class PresignAttachmentDto {
  @ApiProperty({
    description: 'Original filename with extension',
    example: 'design_spec.pdf',
  })
  @IsNotEmpty()
  @IsString()
  filename!: string;

  @ApiPropertyOptional({
    enum: EntityType,
    description: 'Entity type: WorkItem, comment, page, sticky, project',
    example: 'work_item',
  })
  @IsOptional()
  @IsEnum(EntityType)
  entityType?: EntityType;

  @ApiPropertyOptional({
    description: 'ID of the entity this attachment belongs to',
    example: 'b1a2c3d4-0000-0000-0000-000000000000',
  })
  @IsOptional()
  @IsString()
  entityId?: string;

  @ApiPropertyOptional({
    description: 'MIME type of the file',
    example: 'application/pdf',
  })
  @IsOptional()
  @IsString()
  contentType?: string;

  @ApiPropertyOptional({
    description: 'Alias for contentType (MIME type of the file)',
    example: 'application/pdf',
  })
  @IsOptional()
  @IsString()
  mimeType?: string;

  @ApiPropertyOptional({ description: 'File size in bytes', example: 1048576 })
  @IsOptional()
  @IsInt()
  @Min(1)
  size?: number;

  @ApiPropertyOptional({ description: 'Project ID' })
  @IsOptional()
  @IsString()
  projectId?: string;
}

export class AddAttachmentDto extends BaseAttachmentMetadataDto {
  @ApiPropertyOptional({ description: 'Filename', example: 'specs.pdf' })
  @IsOptional()
  @IsString()
  filename?: string;

  @ApiPropertyOptional({
    description: 'Legacy name alias for filename',
    example: 'specs.pdf',
  })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({
    description: 'URL of the uploaded attachment',
    example: '/api/v1/storage/files/r2/...',
  })
  @IsNotEmpty()
  @IsString()
  url!: string;
}

export class AttachPageDto {
  @ApiProperty({
    description: 'Page ID',
    example: 'd3b07384-d113-4603-a417-cc2349e5d7a6',
  })
  @IsNotEmpty()
  @IsString()
  pageId!: string;

  @ApiPropertyOptional({
    description: 'Page Title',
    example: 'Research Methodology Notes',
  })
  @IsOptional()
  @IsString()
  title?: string;
}

export class AttachPaperDto {
  @ApiProperty({
    description: 'Paper ID',
    example: 'p-10.1103/PhysRevLett.116.061102',
  })
  @IsNotEmpty()
  @IsString()
  paperId!: string;

  @ApiPropertyOptional({
    description: 'Paper Title',
    example: 'Observation of Gravitational Waves',
  })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional({
    description: 'Paper DOI',
    example: '10.1103/PhysRevLett.116.061102',
  })
  @IsOptional()
  @IsString()
  doi?: string;

  @ApiPropertyOptional({
    description: 'BibTeX Citation Key',
    example: 'Abbott2016',
  })
  @IsOptional()
  @IsString()
  citationKey?: string;
}

export class AttachFileDto {
  @ApiProperty({ description: 'File Name', example: 'experiment_dataset.csv' })
  @IsNotEmpty()
  @IsString()
  name!: string;

  @ApiProperty({
    description: 'File URL',
    example: 'https://r2.flux.internal/attachments/...',
  })
  @IsNotEmpty()
  @IsString()
  url!: string;

  @ApiPropertyOptional({ description: 'Size in bytes', example: 1048576 })
  @IsOptional()
  size?: number | string;

  @ApiPropertyOptional({ description: 'MIME Type', example: 'text/csv' })
  @IsOptional()
  @IsString()
  type?: string;
}

export class AttachLinkDto {
  @ApiProperty({ description: 'Link Title', example: 'ArXiv Preprint' })
  @IsNotEmpty()
  @IsString()
  title!: string;

  @ApiProperty({
    description: 'Link URL',
    example: 'https://arxiv.org/abs/2106.12345',
  })
  @IsNotEmpty()
  @IsString()
  url!: string;
}
