/**
 * modules/manuscripts/clsi/dto/clsi.dto.ts
 * Data Transfer Objects for CLSI Compile & Word Count operations
 */

import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum ClsiCompilerEngine {
  PDFLATEX = 'pdflatex',
  XELATEX = 'xelatex',
  LUALATEX = 'lualatex',
  TECTONIC = 'tectonic',
}

export class CompileManuscriptDto {
  @ApiPropertyOptional({ description: 'Target Project ID' })
  @IsString()
  @IsOptional()
  project_id?: string;

  @ApiPropertyOptional({ description: 'Target Project ID (camelCase)' })
  @IsString()
  @IsOptional()
  projectId?: string;

  @ApiPropertyOptional({ description: 'Target Document / Page ID' })
  @IsString()
  @IsOptional()
  page_id?: string;

  @ApiPropertyOptional({ description: 'Target Document / Page ID (camelCase)' })
  @IsString()
  @IsOptional()
  pageId?: string;

  @ApiPropertyOptional({ description: 'Main entry TeX file', default: 'main.tex' })
  @IsString()
  @IsOptional()
  main_file?: string;

  @ApiPropertyOptional({ description: 'Raw TeX source content' })
  @IsString()
  @IsOptional()
  source?: string;

  @ApiPropertyOptional({
    enum: ClsiCompilerEngine,
    default: ClsiCompilerEngine.PDFLATEX,
  })
  @IsEnum(ClsiCompilerEngine)
  @IsOptional()
  engine?: ClsiCompilerEngine;

  @ApiPropertyOptional({ description: 'Draft compilation (skips images/PDF embed for speed)' })
  @IsBoolean()
  @IsOptional()
  draft?: boolean;

  @ApiPropertyOptional({ description: 'Syntax only compilation (skips PDF generation for fast diagnostics)' })
  @IsBoolean()
  @IsOptional()
  syntax_only?: boolean;

  @ApiPropertyOptional({ description: 'Syntax only compilation (camelCase)' })
  @IsBoolean()
  @IsOptional()
  syntaxOnly?: boolean;

  @ApiPropertyOptional({ description: 'Compilation timeout in milliseconds', default: 30000 })
  @IsNumber()
  @IsOptional()
  timeout_ms?: number;

  @ApiPropertyOptional({ description: 'Compilation timeout in milliseconds (camelCase)' })
  @IsNumber()
  @IsOptional()
  timeoutMs?: number;

  @ApiPropertyOptional({ description: 'Use cached compile results', default: true })
  @IsBoolean()
  @IsOptional()
  use_cache?: boolean;

  @ApiPropertyOptional({ description: 'Halt on first LaTeX error' })
  @IsBoolean()
  @IsOptional()
  stop_on_first_error?: boolean;

  @ApiPropertyOptional({ description: 'Multi-file dictionary: path -> content' })
  @IsOptional()
  files?: Record<string, string>;
}

export class ClsiWordCountDto {
  @ApiProperty({ description: 'LaTeX source content to analyze' })
  @IsString()
  @IsNotEmpty({ message: 'Source content is required for word count' })
  source!: string;

  @ApiPropertyOptional({ description: 'Optional page ID' })
  @IsString()
  @IsOptional()
  pageId?: string;

  @ApiPropertyOptional({ description: 'Optional project ID' })
  @IsString()
  @IsOptional()
  projectId?: string;
}
