/**
 * modules/manuscripts/clsi/dto/clsi.dto.ts
 * Canonical Data Transfer Objects for the Common LaTeX Service Interface (CLSI).
 */

import {
  IsString,
  IsOptional,
  IsBoolean,
  IsIn,
  IsObject,
  IsNumber,
  Min,
  Max,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CompileManuscriptDto {
  @ApiPropertyOptional({
    description: 'Project UUID for multi-file compile',
    example: 'project-uuid-123',
  })
  @IsOptional()
  @IsString()
  projectId?: string;

  @ApiPropertyOptional({
    description: 'Editor page UUID when compiling from a workspace page',
    example: 'page-uuid-123',
  })
  @IsOptional()
  @IsString()
  pageId?: string;

  @ApiPropertyOptional({
    description: 'Main TeX file relative path',
    example: 'main.tex',
  })
  @IsOptional()
  @IsString()
  mainFile?: string;

  @ApiPropertyOptional({
    description: 'Raw LaTeX source content (max 15MB)',
    example: '\\documentclass{article}\\begin{document}Hello\\end{document}',
  })
  @IsOptional()
  @IsString()
  @MaxLength(15 * 1024 * 1024, {
    message: 'LaTeX source exceeds maximum allowed size of 15MB',
  })
  source?: string;

  @ApiPropertyOptional({
    description: 'TeX compiler engine',
    enum: ['pdflatex', 'xelatex', 'lualatex', 'latex'],
    default: 'pdflatex',
  })
  @IsOptional()
  @IsIn(['pdflatex', 'xelatex', 'lualatex', 'latex'])
  engine?: 'pdflatex' | 'xelatex' | 'lualatex' | 'latex';

  @ApiPropertyOptional({
    description: 'TeX Live distribution version',
    enum: ['2025', '2024', '2023', '2022', '2021'],
    default: '2025',
  })
  @IsOptional()
  @IsIn(['2025', '2024', '2023', '2022', '2021'])
  texLiveVersion?: string;

  @ApiPropertyOptional({
    description: 'Enable fast draft compilation mode',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  draft?: boolean;

  @ApiPropertyOptional({
    description: 'Syntax validation only (-draftmode, no PDF output)',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  syntaxOnly?: boolean;

  @ApiPropertyOptional({
    description: 'Compilation timeout in milliseconds',
    default: 240000,
    minimum: 5000,
    maximum: 600000,
  })
  @IsOptional()
  @IsNumber()
  @Min(5000)
  @Max(600000)
  timeoutMs?: number;

  @ApiPropertyOptional({
    description: 'Use compilation cache if available',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  useCache?: boolean;

  @ApiPropertyOptional({
    description: 'Force clean auxiliary files before compilation',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  forceClean?: boolean;

  @ApiPropertyOptional({
    description: 'Halt compilation on the first LaTeX error',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  stopOnFirstError?: boolean;

  @ApiPropertyOptional({
    description: 'Additional virtual files map (filename -> content)',
  })
  @IsOptional()
  @IsObject()
  files?: Record<string, string>;
}

export class ClsiWordCountDto {
  @ApiPropertyOptional({
    description: 'LaTeX source to count words from (max 15MB)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(15 * 1024 * 1024, {
    message: 'LaTeX source exceeds maximum allowed size of 15MB',
  })
  source?: string;

  @ApiPropertyOptional({
    description: 'Project UUID for resolving multi-file \\input / \\include',
  })
  @IsOptional()
  @IsString()
  projectId?: string;

  @ApiPropertyOptional({
    description: 'Filename for reporting (default: document.tex)',
  })
  @IsOptional()
  @IsString()
  filename?: string;

  @ApiPropertyOptional({
    description: 'Whether to include bibliography/bibitem words in totalWords',
  })
  @IsOptional()
  @IsBoolean()
  includeBib?: boolean;

  @ApiPropertyOptional({
    description: 'Optional virtual files map (filename -> content) for project word count',
  })
  @IsOptional()
  @IsObject()
  files?: Record<string, string>;
}

export class ClsiAiTransformDto {
  @ApiProperty({
    description: 'Academic writing action type',
    enum: [
      'academic-tone',
      'make-concise',
      'fix-grammar',
      'translate-english',
      'custom',
    ],
  })
  @IsString()
  action!:
    | 'academic-tone'
    | 'make-concise'
    | 'fix-grammar'
    | 'translate-english'
    | 'custom';

  @ApiProperty({ description: 'Selected LaTeX/Markdown text to transform' })
  @IsString()
  selectedText!: string;

  @ApiPropertyOptional({ description: 'Custom instruction when action is custom' })
  @IsOptional()
  @IsString()
  customPrompt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  contextBefore?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  contextAfter?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  documentTitle?: string;
}

export class ClsiAiFixErrorDto {
  @ApiProperty({ description: 'Compiler error message' })
  @IsString()
  errorMessage!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  errorLine?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  errorFile?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  detail?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  surroundingCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  fullCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  pageId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  projectId?: string;
}

export class ClsiAiGenerateTableDto {
  @ApiProperty({ description: 'Natural language description of the table' })
  @IsString()
  prompt!: string;
}

