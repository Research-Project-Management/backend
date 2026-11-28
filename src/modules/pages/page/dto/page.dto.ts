/**
 * modules/pages/page/dto/page.dto.ts
 * Request DTOs with class-validator & Swagger decorators for PageController.
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class UpdatePageThumbnailDto {
  @ApiPropertyOptional({
    description: 'Base64 data URL of rendered PDF first-page thumbnail',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512_000)
  pdfThumbnail?: string;
}

export class CreatePageFileDto {
  @ApiPropertyOptional({
    description: 'File title / relative path (e.g. chapters/intro.tex)',
  })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional({ description: 'Alias for file name' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ description: 'Initial file text content' })
  @IsOptional()
  @IsString()
  content?: string;
}

export class ImportFileFromProjectDto {
  @ApiProperty({ description: 'Source file/doc ID to import' })
  @IsString()
  @IsNotEmpty()
  sourceFileId!: string;

  @ApiPropertyOptional({ description: 'Source project/space ID' })
  @IsOptional()
  @IsString()
  sourceProjectId?: string;

  @ApiPropertyOptional({ description: 'Optional target filename override' })
  @IsOptional()
  @IsString()
  targetName?: string;

  @ApiPropertyOptional({
    description: 'Optional target relative path override',
  })
  @IsOptional()
  @IsString()
  targetPath?: string;

  @ApiPropertyOptional({ description: 'Optional target parent page ID' })
  @IsOptional()
  @IsString()
  parentPageId?: string;
}

export class CreateProjectPageDto {
  @ApiPropertyOptional({ description: 'Page title' })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional({ description: 'Initial TeX content' })
  @IsOptional()
  @IsString()
  content?: string;

  @ApiPropertyOptional({ description: 'Optional page description' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ enum: ['draft', 'published', 'archived'] })
  @IsOptional()
  @IsIn(['draft', 'published', 'archived'])
  status?: 'draft' | 'published' | 'archived';

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  labelIds?: string[];

  @ApiPropertyOptional({ enum: ['blank', 'example'] })
  @IsOptional()
  @IsIn(['blank', 'example'])
  templateType?: 'blank' | 'example';
}

export class AssignPageLabelsDto {
  @ApiPropertyOptional({
    type: [String],
    description: 'Label IDs to assign to the page',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  labelIds?: string[];
}

export class UpdatePageMetadataDto {
  @ApiPropertyOptional({ description: 'Updated page title' })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional({ description: 'Updated page description' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ enum: ['draft', 'published', 'archived'] })
  @IsOptional()
  @IsIn(['draft', 'published', 'archived'])
  status?: 'draft' | 'published' | 'archived';

  @ApiPropertyOptional({
    enum: ['pdflatex', 'xelatex', 'lualatex', 'latex'],
    description: 'LaTeX compiler engine for this page',
  })
  @IsOptional()
  @IsIn(['pdflatex', 'xelatex', 'lualatex', 'latex'])
  compiler?: string;

  @ApiPropertyOptional({
    description: 'TeX Live distribution version (e.g. 2025)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  texlive?: string;

  @ApiPropertyOptional({
    description: 'Spell check language code (e.g. en_US)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  spellLang?: string;

  @ApiPropertyOptional({
    description: 'Root compilation document UUID (PageDoc.id)',
  })
  @IsOptional()
  @IsUUID()
  rootDocId?: string;
}
