/**
 * modules/manuscripts/clsi/dto/synctex.dto.ts
 * Canonical Data Transfer Objects for Forward and Reverse SyncTeX navigation.
 */

import {
  IsString,
  IsNumber,
  IsOptional,
  Min,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ForwardSyncDto {
  @ApiProperty({ description: 'Source file name', example: 'main.tex' })
  @IsString()
  @MaxLength(512)
  file!: string;

  @ApiProperty({ description: '1-based line number in TeX source', example: 42 })
  @IsNumber()
  @Min(1)
  line!: number;

  @ApiPropertyOptional({
    description: '1-based column number',
    example: 1,
    default: 1,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  column?: number;

  @ApiPropertyOptional({ description: 'Project ID for workspace lookup' })
  @IsOptional()
  @IsString()
  projectId?: string;

  @ApiPropertyOptional({ description: 'Page ID fallback for workspace lookup' })
  @IsOptional()
  @IsString()
  pageId?: string;

  @ApiPropertyOptional({
    description: 'Base64-encoded synctex payload (max 10MB)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(10 * 1024 * 1024)
  synctex?: string;
}

export class ReverseSyncDto {
  @ApiProperty({ description: '1-based PDF page number', example: 1 })
  @IsNumber()
  @Min(1)
  page!: number;

  @ApiProperty({ description: 'X coordinate in PDF points', example: 120.5 })
  @IsNumber()
  x!: number;

  @ApiProperty({ description: 'Y coordinate in PDF points', example: 340.0 })
  @IsNumber()
  y!: number;

  @ApiPropertyOptional({ description: 'Project ID for workspace lookup' })
  @IsOptional()
  @IsString()
  projectId?: string;

  @ApiPropertyOptional({ description: 'Page ID fallback for workspace lookup' })
  @IsOptional()
  @IsString()
  pageId?: string;

  @ApiPropertyOptional({
    description: 'Base64-encoded synctex payload (max 10MB)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(10 * 1024 * 1024)
  synctex?: string;
}
