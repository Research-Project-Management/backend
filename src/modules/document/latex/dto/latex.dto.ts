import { IsArray, IsBoolean, IsEnum, IsOptional, IsString } from 'class-validator';

export enum LatexEngine {
  PDFLATEX = 'pdflatex',
  XELATEX = 'xelatex',
  LUALATEX = 'lualatex',
}

export class CompileLatexDto {
  @IsString()
  @IsOptional()
  project_id?: string;

  @IsString()
  @IsOptional()
  page_id?: string;

  @IsString()
  @IsOptional()
  main_file?: string;

  @IsString()
  @IsOptional()
  source?: string;

  @IsEnum(LatexEngine)
  @IsOptional()
  engine?: LatexEngine;

  @IsBoolean()
  @IsOptional()
  draft?: boolean;

  @IsBoolean()
  @IsOptional()
  use_cache?: boolean;
}

export class SyncIncrementalDto {
  @IsArray()
  @IsOptional()
  @IsString({ each: true })
  dirtyFileIds?: string[];

  @IsBoolean()
  @IsOptional()
  forceAll?: boolean;
}
