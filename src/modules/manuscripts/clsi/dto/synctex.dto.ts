/**
 * modules/manuscripts/clsi/dto/synctex.dto.ts
 * Data Transfer Objects for SyncTeX forward/reverse coordinate mapping
 */

import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ForwardSyncDto {
  @ApiProperty({ description: 'Source filename (e.g. main.tex, intro.tex)' })
  @IsString()
  @IsNotEmpty({ message: 'Filename is required for forward sync' })
  file!: string;

  @ApiProperty({ description: 'Line number in the source file (1-indexed)' })
  @IsNumber()
  @Min(1)
  line!: number;

  @ApiPropertyOptional({
    description: 'Column number in the source file (0-indexed)',
    default: 0,
  })
  @IsNumber()
  @IsOptional()
  column?: number;

  @ApiPropertyOptional({ description: 'Project ID context' })
  @IsString()
  @IsOptional()
  projectId?: string;

  @ApiPropertyOptional({ description: 'Document page ID context' })
  @IsString()
  @IsOptional()
  pageId?: string;

  @ApiPropertyOptional({
    description: 'Raw plaintext SyncTeX data from compilation',
  })
  @IsString()
  @IsOptional()
  synctex?: string;
}

export class ReverseSyncDto {
  @ApiProperty({ description: 'Rendered PDF page number (1-indexed)' })
  @IsNumber()
  @Min(1)
  page!: number;

  @ApiProperty({ description: 'X coordinate in points on the PDF page' })
  @IsNumber()
  x!: number;

  @ApiProperty({ description: 'Y coordinate in points on the PDF page' })
  @IsNumber()
  y!: number;

  @ApiPropertyOptional({ description: 'Project ID context' })
  @IsString()
  @IsOptional()
  projectId?: string;

  @ApiPropertyOptional({ description: 'Document page ID context' })
  @IsString()
  @IsOptional()
  pageId?: string;

  @ApiPropertyOptional({
    description: 'Raw plaintext SyncTeX data from compilation',
  })
  @IsString()
  @IsOptional()
  synctex?: string;
}
