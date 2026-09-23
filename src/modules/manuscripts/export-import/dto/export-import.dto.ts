/**
 * export-import/dto/export-import.dto.ts
 * Data Transfer Objects for Manuscripts Project Archive, ZIP Export/Import & Templates.
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsBoolean, IsOptional } from 'class-validator';
import { Transform } from 'class-transformer';

export class ExportZipQueryDto {
  @ApiPropertyOptional({ description: 'Include latest compiled output.pdf in the archive package', default: false })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  includePdf?: boolean;

  @ApiPropertyOptional({ description: 'Custom archive file name' })
  @IsOptional()
  @IsString()
  projectName?: string;
}

export class ScaffoldTemplateDto {
  @ApiProperty({ description: 'Identifier of the academic template (e.g., ieee-transactions, acm-sigconf)' })
  @IsString()
  @IsNotEmpty()
  templateId!: string;
}

export class ImportSummaryResponseDto {
  @ApiProperty()
  projectId!: string;

  @ApiProperty()
  totalEntries!: number;

  @ApiProperty()
  totalDocs!: number;

  @ApiProperty()
  totalFiles!: number;

  @ApiProperty()
  totalFolders!: number;

  @ApiPropertyOptional({ nullable: true })
  rootDocId!: string | null;

  @ApiPropertyOptional({ nullable: true })
  rootDocPath!: string | null;
}

export class TemplateResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  category!: string;

  @ApiProperty()
  description!: string;

  @ApiProperty()
  author!: string;

  @ApiPropertyOptional({ nullable: true })
  thumbnailUrl!: string | null;

  @ApiProperty()
  fileCount!: number;

  @ApiProperty()
  defaultRootDoc!: string;
}
