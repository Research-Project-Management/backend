import { IsEnum, IsOptional, IsString, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
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

export class UpdateVersionDto {
  @IsString()
  @IsOptional()
  label?: string;

  @IsString()
  @IsOptional()
  title?: string;
}

export class VersionQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @IsEnum(VersionEventType)
  eventType?: VersionEventType;
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
  fromContent: string;
  toContent: string;
  chunks: DiffChunk[];
  stats: {
    addedLines: number;
    deletedLines: number;
    unchangedLines: number;
  };
}
