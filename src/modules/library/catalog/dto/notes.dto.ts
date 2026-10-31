import {
  ArrayMaxSize,
  IsString,
  IsOptional,
  IsArray,
  IsInt,
  IsBoolean,
  IsIn,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';

export class CreateNoteDto {
  @IsString()
  @IsOptional()
  @MaxLength(100)
  itemId?: string | null;

  @IsString()
  @IsOptional()
  @MaxLength(500)
  title?: string;

  @IsOptional()
  contentJson?: Record<string, unknown> | null;

  @IsString()
  @IsOptional()
  @MaxLength(500000)
  contentMd?: string;

  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  @IsOptional()
  tags?: string[];

  @IsString()
  @IsOptional()
  @MaxLength(100)
  projectId?: string | null;
}

export class UpdateNoteDto {
  @IsString()
  @IsOptional()
  @MaxLength(500)
  title?: string;

  @IsOptional()
  contentJson?: Record<string, unknown> | null;

  @IsString()
  @IsOptional()
  @MaxLength(500000)
  contentMd?: string;

  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  @IsOptional()
  tags?: string[];

  @Transform(
    ({ value, obj }: { value: unknown; obj?: Record<string, unknown> }) => {
      if (typeof value === 'number') return value;
      if (typeof obj?.version === 'number') return obj.version;
      return value;
    },
  )
  @IsInt()
  @IsOptional()
  expectedVersion?: number;

  @IsInt()
  @IsOptional()
  version?: number;
}

export class ExtractNotesFromAnnotationsDto {
  @IsString()
  @IsOptional()
  @MaxLength(100)
  noteId?: string;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  attachmentId?: string;

  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  @IsOptional()
  annotationIds?: string[];

  @IsOptional()
  tagColor?: boolean | string;

  @IsString()
  @IsOptional()
  @MaxLength(200)
  tagColorName?: string;

  @IsBoolean()
  @IsOptional()
  includeComments?: boolean;

  @IsIn(['flux', 'web', 'zotero'])
  @IsOptional()
  protocol?: 'flux' | 'web';

  @IsString()
  @IsOptional()
  @MaxLength(500)
  webBaseUrl?: string;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  projectId?: string;
}
