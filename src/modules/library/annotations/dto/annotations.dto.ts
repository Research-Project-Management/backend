import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Min,
  MaxLength,
  Matches,
} from 'class-validator';
import { AnnotationType } from '@prisma/client';

export class CreateAnnotationDto {
  @IsEnum(AnnotationType)
  @IsOptional()
  type?: AnnotationType;

  @IsInt()
  @Min(0)
  pageIndex!: number;

  @IsString()
  @Matches(/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/, {
    message:
      'color must be a valid 3-char or 6-char hex color code (e.g. #ffeb3b)',
  })
  @IsOptional()
  color?: string;

  @IsString()
  @MaxLength(10000)
  @IsOptional()
  quoteText?: string;

  @IsString()
  @MaxLength(5000)
  @IsOptional()
  comment?: string;

  @IsOptional()
  rectCoords?: Record<string, unknown> | Array<unknown> | null;
}

export class UpdateAnnotationDto {
  @IsString()
  @Matches(/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/, {
    message:
      'color must be a valid 3-char or 6-char hex color code (e.g. #ffeb3b)',
  })
  @IsOptional()
  color?: string;

  @IsString()
  @MaxLength(10000)
  @IsOptional()
  quoteText?: string;

  @IsString()
  @MaxLength(5000)
  @IsOptional()
  comment?: string;

  @IsOptional()
  rectCoords?: Record<string, unknown> | Array<unknown> | null;

  @IsInt()
  @Min(1)
  @IsOptional()
  expectedVersion?: number;
}
