import { IsNotEmpty, IsOptional, IsString, IsInt, Min, IsObject } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateAttachmentDto {
  @ApiPropertyOptional({ description: 'Filename', example: 'specs.pdf' })
  @IsOptional()
  @IsString()
  filename?: string;

  @ApiPropertyOptional({ description: 'Legacy name alias for filename', example: 'specs.pdf' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({ description: 'URL of the uploaded attachment', example: '/api/files/r2/...' })
  @IsNotEmpty()
  @IsString()
  url!: string;

  @ApiPropertyOptional({ description: 'Storage key' })
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

  @ApiPropertyOptional({ description: 'Additional metadata' })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}

// Backward compatibility alias
export const CreateWorkItemAttachmentDto = CreateAttachmentDto;
export type CreateWorkItemAttachmentDto = CreateAttachmentDto;
