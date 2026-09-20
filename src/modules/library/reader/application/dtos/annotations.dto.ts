import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsNumber,
  Min,
  Max,
  MaxLength,
  Matches,
  IsArray,
  IsUUID,
  ValidateNested,
  ArrayMaxSize,
  ArrayMinSize,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { AnnotationType } from '../../domain/types/annotations.types';

// ─── Shared color validator ───────────────────────────────────────────────────

const COLOR_REGEX = /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/;
const COLOR_MSG = 'color must be a valid hex color (e.g. #ffd400 or #fff)';

// ─── Create ──────────────────────────────────────────────────────────────────

export class CreateAnnotationDto {
  @IsEnum(AnnotationType)
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value !== 'string') return value;
    const lower = value.toLowerCase();
    if (lower === 'box' || lower === 'area') return AnnotationType.rect;
    if (lower === 'strikethrough') return AnnotationType.strike;
    if (lower === 'freetext') return AnnotationType.text;
    return lower as AnnotationType;
  })
  type?: AnnotationType;

  @IsInt()
  @Min(0)
  pageIndex!: number;

  /**
   * Y position in page-relative coordinates [0, 1].
   * Used to build `annotationSortIndex` (0 = top of page).
   */
  @IsNumber()
  @Min(0)
  @Max(1)
  @IsOptional()
  y?: number;

  /**
   * X position in page-relative coordinates [0, 1].
   * Used to build `annotationSortIndex` (0 = left of page).
   */
  @IsNumber()
  @Min(0)
  @Max(1)
  @IsOptional()
  x?: number;

  @IsString()
  @Matches(COLOR_REGEX, { message: COLOR_MSG })
  @IsOptional()
  color?: string;

  @IsString()
  @MaxLength(10_000)
  @IsOptional()
  quoteText?: string;

  @IsString()
  @MaxLength(5_000)
  @IsOptional()
  comment?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];

  @IsOptional()
  rectCoords?: Record<string, unknown> | Array<unknown> | null;
}

// ─── Update ──────────────────────────────────────────────────────────────────

export class UpdateAnnotationDto {
  @IsString()
  @Matches(COLOR_REGEX, { message: COLOR_MSG })
  @IsOptional()
  color?: string;

  @IsString()
  @MaxLength(10_000)
  @IsOptional()
  quoteText?: string;

  @IsString()
  @MaxLength(5_000)
  @IsOptional()
  comment?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];

  @IsOptional()
  rectCoords?: Record<string, unknown> | Array<unknown> | null;

  /** Optimistic lock version. Also accepted via If-Match header. */
  @IsInt()
  @Min(1)
  @IsOptional()
  expectedVersion?: number;
}

// ─── Batch upsert item ───────────────────────────────────────────────────────

export class UpsertAnnotationItemDto {
  /** If present → update existing annotation, otherwise create new */
  @IsUUID('4')
  @IsOptional()
  id?: string;

  @IsEnum(AnnotationType)
  @IsOptional()
  type?: AnnotationType;

  @IsInt()
  @Min(0)
  pageIndex!: number;

  @IsNumber()
  @Min(0)
  @Max(1)
  @IsOptional()
  y?: number;

  @IsNumber()
  @Min(0)
  @Max(1)
  @IsOptional()
  x?: number;

  @IsString()
  @Matches(COLOR_REGEX, { message: COLOR_MSG })
  @IsOptional()
  color?: string;

  @IsString()
  @MaxLength(10_000)
  @IsOptional()
  quoteText?: string;

  @IsString()
  @MaxLength(5_000)
  @IsOptional()
  comment?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];

  @IsOptional()
  rectCoords?: Record<string, unknown> | Array<unknown> | null;

  /**
   * Required when `id` is provided.
   * Enforces optimistic concurrency on batch updates.
   */
  @IsInt()
  @Min(1)
  @IsOptional()
  expectedVersion?: number;
}

// ─── Batch request ───────────────────────────────────────────────────────────

export class BatchAnnotationsDto {
  @IsArray()
  @ArrayMinSize(0)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => UpsertAnnotationItemDto)
  upserts!: UpsertAnnotationItemDto[];

  @IsArray()
  @ArrayMinSize(0)
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  deletes!: string[];
}
