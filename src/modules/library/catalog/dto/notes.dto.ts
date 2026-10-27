import {
  ArrayMaxSize,
  IsString,
  IsOptional,
  IsArray,
  IsInt,
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

  @Transform(({ value, obj }: { value: unknown; obj?: Record<string, unknown> }) => {
    if (typeof value === 'number') return value;
    if (typeof obj?.version === 'number') return obj.version;
    return value;
  })
  @IsInt()
  @IsOptional()
  expectedVersion?: number;

  @IsInt()
  @IsOptional()
  version?: number;
}
