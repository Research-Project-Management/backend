import { IsArray, IsEnum, IsOptional, IsString } from 'class-validator';

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
  source?: string;

  @IsEnum(LatexEngine)
  @IsOptional()
  engine?: LatexEngine;
}

export class SyncIncrementalDto {
  @IsArray()
  @IsOptional()
  dirtyFileIds?: string[];

  @IsOptional()
  forceAll?: boolean;
}
