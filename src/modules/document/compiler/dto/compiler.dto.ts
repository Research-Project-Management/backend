import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';

export enum CompilerEngine {
  PDFLATEX = 'pdflatex',
  XELATEX = 'xelatex',
  LUALATEX = 'lualatex',
}

export const LatexEngine = CompilerEngine;
export type LatexEngine = CompilerEngine;

export class CompileLatexDto {
  @IsString()
  @IsOptional()
  project_id?: string;

  @IsString()
  @IsOptional()
  projectId?: string;

  @IsString()
  @IsOptional()
  page_id?: string;

  @IsString()
  @IsOptional()
  pageId?: string;

  @IsString()
  @IsOptional()
  main_file?: string;

  @IsString()
  @IsOptional()
  source?: string;

  @IsEnum(CompilerEngine)
  @IsOptional()
  engine?: CompilerEngine;

  @IsBoolean()
  @IsOptional()
  draft?: boolean;

  @IsBoolean()
  @IsOptional()
  use_cache?: boolean;

  @IsBoolean()
  @IsOptional()
  stop_on_first_error?: boolean;

  @IsOptional()
  files?: Record<string, string>;
}

export const CompileCompilerDto = CompileLatexDto;
export type CompileCompilerDto = CompileLatexDto;

export class WordCountDto {
  @IsString()
  @IsNotEmpty({ message: 'Source content is required for word count' })
  source!: string;

  @IsString()
  @IsOptional()
  pageId?: string;

  @IsString()
  @IsOptional()
  projectId?: string;
}

export class SyncIncrementalDto {
  @IsArray()
  @IsOptional()
  @IsString({ each: true })
  dirtyFileIds?: string[];

  @IsBoolean()
  @IsOptional()
  forceAll?: boolean;

  @IsString()
  @IsOptional()
  projectId?: string;
}

export class SaveAndSyncDto {
  @ApiPropertyOptional({ description: 'Page Title' })
  @IsString()
  @IsOptional()
  title?: string;

  @ApiPropertyOptional({ description: 'Rich text or LaTeX Content' })
  @IsOptional()
  content?: Prisma.InputJsonValue;

  @ApiPropertyOptional({
    description: 'Force creating a named version snapshot immediately',
  })
  @IsBoolean()
  @IsOptional()
  createSnapshot?: boolean;

  @ApiPropertyOptional({
    description: 'Optional change description for snapshot',
  })
  @IsString()
  @IsOptional()
  versionDescription?: string;
}

export class CompileDocumentDto {
  @ApiPropertyOptional({
    description: 'Compiler Engine (pdflatex, xelatex, lualatex)',
    enum: CompilerEngine,
    default: CompilerEngine.PDFLATEX,
  })
  @IsEnum(CompilerEngine)
  @IsOptional()
  engine?: CompilerEngine;

  @ApiPropertyOptional({ description: 'Custom raw LaTeX preamble or override' })
  @IsString()
  @IsOptional()
  source?: string;

  @ApiPropertyOptional({
    description: 'Document class (e.g. article, report, IEEEtran, acmart)',
    default: 'article',
  })
  @IsString()
  @IsOptional()
  documentClass?: string;
}
