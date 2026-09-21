import { IsEnum, IsOptional, IsString, IsInt, Min, Max, IsBoolean } from 'class-validator';
import { Type, Transform } from 'class-transformer';
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

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  labeledOnly?: boolean;
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
