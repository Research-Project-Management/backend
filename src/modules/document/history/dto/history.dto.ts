import { IsEnum, IsOptional, IsString } from 'class-validator';
import { VersionEventType } from '@prisma/client';

export class CreateVersionDto {
  @IsString()
  @IsOptional()
  title?: string;

  @IsString()
  @IsOptional()
  content?: string;

  @IsString()
  @IsOptional()
  label?: string;

  @IsEnum(VersionEventType)
  @IsOptional()
  eventType?: VersionEventType;

  @IsString()
  @IsOptional()
  fileName?: string;

  @IsString()
  @IsOptional()
  projectPageId?: string;

  @IsString()
  @IsOptional()
  rootPageId?: string;

  @IsString()
  @IsOptional()
  projectId?: string;
}

export interface DiffChunk {
  type: 'added' | 'deleted' | 'unchanged';
  value: string;
  linesCount: number;
}

export interface VersionDiffResult {
  fromVersionId: string;
  toVersionId: string;
  fromLabel?: string;
  toLabel?: string;
  chunks: DiffChunk[];
  stats: {
    addedLines: number;
    deletedLines: number;
    unchangedLines: number;
  };
}
