import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Min,
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
  @IsOptional()
  color?: string;

  @IsString()
  @IsOptional()
  quoteText?: string;

  @IsString()
  @IsOptional()
  comment?: string;

  @IsOptional()
  rectCoords?: Record<string, unknown> | Array<unknown> | null;
}

export class UpdateAnnotationDto {
  @IsString()
  @IsOptional()
  color?: string;

  @IsString()
  @IsOptional()
  quoteText?: string;

  @IsString()
  @IsOptional()
  comment?: string;

  @IsOptional()
  rectCoords?: Record<string, unknown> | Array<unknown> | null;

  @IsInt()
  @IsOptional()
  expectedVersion?: number;
}
