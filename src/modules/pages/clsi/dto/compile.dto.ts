/**
 * modules/pages/clsi/dto/compile.dto.ts
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

export class CompilePageDto {
  @ApiPropertyOptional({
    description: 'Workspace Space UUID (Personal or Project)',
    example: 'space-uuid-123',
  })
  @IsOptional()
  @IsString()
  spaceId?: string;

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
    enum: ['2026', '2025', '2024', '2023', '2022', '2021', '2020'],
    default: '2025',
  })
  @IsOptional()
  @IsIn(['2026', '2025', '2024', '2023', '2022', '2021', '2020'])
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
    description:
      'Requested compilation timeout in milliseconds (clamped to server tier cap)',
    default: 90000,
    minimum: 5000,
    maximum: 240000,
  })
  @IsOptional()
  @IsNumber()
  @Min(5000)
  @Max(240000)
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

  @ApiPropertyOptional({
    description:
      'Response delivery mode: "inline" embeds Base64 PDF in JSON (default), "artifact" returns binary artifact URLs',
    enum: ['inline', 'artifact'],
    default: 'inline',
  })
  @IsOptional()
  @IsIn(['inline', 'artifact'])
  responseMode?: 'inline' | 'artifact';

  @ApiPropertyOptional({
    description:
      'Compilation priority: "manual" user-triggered compiles take precedence over background "auto" compiles under high concurrency',
    enum: ['manual', 'auto'],
    default: 'manual',
  })
  @IsOptional()
  @IsIn(['manual', 'auto'])
  priority?: 'manual' | 'auto';
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
    description:
      'Workspace Space UUID for resolving multi-file \\input / \\include',
  })
  @IsOptional()
  @IsString()
  spaceId?: string;

  @ApiPropertyOptional({
    description:
      'Page UUID for isolating word counts inside a multi-Page Space',
  })
  @IsOptional()
  @IsString()
  pageId?: string;

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
    description:
      'Optional virtual files map (filename -> content) for multi-file word count',
  })
  @IsOptional()
  @IsObject()
  files?: Record<string, string>;
}
