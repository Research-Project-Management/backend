import { IsEnum, IsNotEmpty, IsOptional, IsString, IsInt, Min, IsObject } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EntityType } from '@prisma/client';

export class CreateAttachmentDto {
  @ApiProperty({ enum: EntityType, description: 'Entity type' })
  @IsNotEmpty()
  @IsEnum(EntityType)
  entityType!: EntityType;

  @ApiProperty({ description: 'Target entity ID' })
  @IsNotEmpty()
  @IsString()
  entityId!: string;

  @ApiProperty({ description: 'Original filename', example: 'architecture.pdf' })
  @IsNotEmpty()
  @IsString()
  filename!: string;

  @ApiProperty({ description: 'Public URL or streaming path of the attachment', example: '/api/files/r2/...' })
  @IsNotEmpty()
  @IsString()
  url!: string;

  @ApiPropertyOptional({ description: 'Storage key in R2 / S3 / local' })
  @IsOptional()
  @IsString()
  storageKey?: string;

  @ApiPropertyOptional({ description: 'Size in bytes', default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  size?: number;

  @ApiPropertyOptional({ description: 'MIME type', default: 'application/octet-stream' })
  @IsOptional()
  @IsString()
  mimeType?: string;

  @ApiPropertyOptional({ description: 'Workspace ID' })
  @IsOptional()
  @IsString()
  workspaceId?: string;

  @ApiPropertyOptional({ description: 'Project ID' })
  @IsOptional()
  @IsString()
  projectId?: string;

  @ApiPropertyOptional({ description: 'Additional custom metadata' })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}
