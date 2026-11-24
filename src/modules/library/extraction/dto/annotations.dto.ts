import {
  Allow,
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
  IsBoolean,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { AnnotationType } from '@prisma/client';

// Shared color validator & named-color canonicalizer

const COLOR_REGEX = /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/;
const COLOR_MSG = 'color must be a valid hex color (e.g. #ffd400 or #fff)';

const NAMED_ANNOTATION_COLORS: Record<string, string> = {
  yellow: '#ffd400',
  red: '#ff6666',
  green: '#5fb236',
  blue: '#2ea8e5',
  purple: '#a28ae5',
  magenta: '#e56eee',
  orange: '#f19837',
  gray: '#aaaaaa',
  grey: '#aaaaaa',
};

function transformAnnotationColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const mapped = NAMED_ANNOTATION_COLORS[trimmed.toLowerCase()];
  return mapped || trimmed;
}

export function normalizeAnnotationType(
  value: unknown,
): AnnotationType | undefined {
  if (typeof value !== 'string') return value as AnnotationType | undefined;
  const lower = value.trim().toLowerCase();
  if (lower === 'box' || lower === 'area') return AnnotationType.rect;
  if (lower === 'image') return AnnotationType.image;
  if (lower === 'strikethrough' || lower === 'strikeout')
    return AnnotationType.strike;
  if (lower === 'squiggly') return AnnotationType.underline;
  if (lower === 'caret') return AnnotationType.note;
  if (lower === 'freetext') return AnnotationType.text;
  if (lower === 'drawing' || lower === 'pen') return AnnotationType.ink;
  return lower as AnnotationType;
}

function resolveRawRectCoords(
  obj?: Record<string, unknown>,
): Record<string, unknown> | Array<unknown> | null | undefined {
  if (!obj) return undefined;
  if (obj.rectCoords !== undefined && obj.rectCoords !== null) {
    return obj.rectCoords as Record<string, unknown> | Array<unknown>;
  }
  if (Array.isArray(obj.rects)) {
    return obj.rects;
  }
  if (obj.boundingRect && typeof obj.boundingRect === 'object') {
    return [obj.boundingRect];
  }
  return obj.rectCoords as null | undefined;
}

function resolveRawRects(obj?: Record<string, unknown>): Array<unknown> | undefined {
  return Array.isArray(obj?.rects) ? obj.rects : undefined;
}

// Create

export class CreateAnnotationDto {
  @IsUUID('all')
  @IsOptional()
  id?: string;

  @IsEnum(AnnotationType)
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => normalizeAnnotationType(value))
  type?: AnnotationType;

  @Transform(
    ({ value, obj }: { value: unknown; obj?: Record<string, unknown> }) => {
      if (typeof value === 'number' && !Number.isNaN(value)) return value;
      if (typeof obj?.pageNumber === 'number' && obj.pageNumber >= 1) {
        return obj.pageNumber - 1;
      }
      return 0;
    },
  )
  @IsInt()
  @Min(0)
  @IsOptional()
  pageIndex: number = 0;

  @IsInt()
  @Min(1)
  @IsOptional()
  pageNumber?: number;

  @IsString()
  @MaxLength(64)
  @IsOptional()
  pageLabel?: string;

  @IsString()
  @MaxLength(64)
  @IsOptional()
  annotationSortIndex?: string;

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

  @Transform(({ value }: { value: unknown }) => transformAnnotationColor(value))
  @IsString()
  @Matches(COLOR_REGEX, { message: COLOR_MSG })
  @IsOptional()
  color?: string;

  @Transform(
    ({ value, obj }: { value: unknown; obj?: Record<string, unknown> }) => {
      if (typeof value === 'string') return value;
      if (typeof obj?.text === 'string') return obj.text;
      return value;
    },
  )
  @IsString()
  @MaxLength(50_000)
  @IsOptional()
  quoteText?: string;

  @IsString()
  @MaxLength(50_000)
  @IsOptional()
  text?: string;

  @IsString()
  @MaxLength(50_000)
  @IsOptional()
  comment?: string;

  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  @IsOptional()
  tags?: string[];

  @Allow()
  @Transform(({ obj }: { obj?: Record<string, unknown> }) =>
    resolveRawRectCoords(obj),
  )
  @IsOptional()
  rectCoords?: Record<string, unknown> | Array<unknown> | null;

  @Transform(({ obj }: { obj?: Record<string, unknown> }) =>
    resolveRawRects(obj),
  )
  @IsArray()
  @ArrayMaxSize(500)
  @IsOptional()
  rects?: Array<unknown>;

  @Allow()
  @IsOptional()
  boundingRect?: Record<string, unknown>;
}

// Update

export class UpdateAnnotationDto {
  @IsEnum(AnnotationType)
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => normalizeAnnotationType(value))
  type?: AnnotationType;

  @Transform(
    ({ value, obj }: { value: unknown; obj?: Record<string, unknown> }) => {
      if (typeof value === 'number' && !Number.isNaN(value)) return value;
      if (typeof obj?.pageNumber === 'number' && obj.pageNumber >= 1) {
        return obj.pageNumber - 1;
      }
      return value;
    },
  )
  @IsInt()
  @Min(0)
  @IsOptional()
  pageIndex?: number;

  @IsInt()
  @Min(1)
  @IsOptional()
  pageNumber?: number;

  @IsString()
  @MaxLength(64)
  @IsOptional()
  pageLabel?: string;

  @IsString()
  @MaxLength(64)
  @IsOptional()
  annotationSortIndex?: string;

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

  @Transform(({ value }: { value: unknown }) => transformAnnotationColor(value))
  @IsString()
  @Matches(COLOR_REGEX, { message: COLOR_MSG })
  @IsOptional()
  color?: string;

  @Transform(
    ({ value, obj }: { value: unknown; obj?: Record<string, unknown> }) => {
      if (typeof value === 'string') return value;
      if (typeof obj?.text === 'string') return obj.text;
      return value;
    },
  )
  @IsString()
  @MaxLength(50_000)
  @IsOptional()
  quoteText?: string;

  @IsString()
  @MaxLength(50_000)
  @IsOptional()
  text?: string;

  @IsString()
  @MaxLength(50_000)
  @IsOptional()
  comment?: string;

  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  @IsOptional()
  tags?: string[];

  @Allow()
  @Transform(({ obj }: { obj?: Record<string, unknown> }) =>
    resolveRawRectCoords(obj),
  )
  @IsOptional()
  rectCoords?: Record<string, unknown> | Array<unknown> | null;

  @Transform(({ obj }: { obj?: Record<string, unknown> }) =>
    resolveRawRects(obj),
  )
  @IsArray()
  @ArrayMaxSize(500)
  @IsOptional()
  rects?: Array<unknown>;

  @Allow()
  @IsOptional()
  boundingRect?: Record<string, unknown>;

  /** Optimistic lock version. Also accepted via If-Match header. */
  @IsInt()
  @Min(1)
  @IsOptional()
  expectedVersion?: number;
}

// Batch upsert item

class UpsertAnnotationItemDto {
  /** If present → update existing annotation, otherwise create new */
  @IsUUID('all')
  @IsOptional()
  id?: string;

  @IsEnum(AnnotationType)
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => normalizeAnnotationType(value))
  type?: AnnotationType;

  @Transform(
    ({ value, obj }: { value: unknown; obj?: Record<string, unknown> }) => {
      if (typeof value === 'number' && !Number.isNaN(value)) return value;
      if (typeof obj?.pageNumber === 'number' && obj.pageNumber >= 1) {
        return obj.pageNumber - 1;
      }
      return 0;
    },
  )
  @IsInt()
  @Min(0)
  @IsOptional()
  pageIndex: number = 0;

  @IsInt()
  @Min(1)
  @IsOptional()
  pageNumber?: number;

  @IsString()
  @MaxLength(64)
  @IsOptional()
  pageLabel?: string;

  @IsString()
  @MaxLength(64)
  @IsOptional()
  annotationSortIndex?: string;

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

  @Transform(({ value }: { value: unknown }) => transformAnnotationColor(value))
  @IsString()
  @Matches(COLOR_REGEX, { message: COLOR_MSG })
  @IsOptional()
  color?: string;

  @Transform(
    ({ value, obj }: { value: unknown; obj?: Record<string, unknown> }) => {
      if (typeof value === 'string') return value;
      if (typeof obj?.text === 'string') return obj.text;
      return value;
    },
  )
  @IsString()
  @MaxLength(50_000)
  @IsOptional()
  quoteText?: string;

  @IsString()
  @MaxLength(50_000)
  @IsOptional()
  text?: string;

  @IsString()
  @MaxLength(50_000)
  @IsOptional()
  comment?: string;

  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  @IsOptional()
  tags?: string[];

  @Allow()
  @Transform(({ obj }: { obj?: Record<string, unknown> }) =>
    resolveRawRectCoords(obj),
  )
  @IsOptional()
  rectCoords?: Record<string, unknown> | Array<unknown> | null;

  @Transform(({ obj }: { obj?: Record<string, unknown> }) =>
    resolveRawRects(obj),
  )
  @IsArray()
  @ArrayMaxSize(500)
  @IsOptional()
  rects?: Array<unknown>;

  @Allow()
  @IsOptional()
  boundingRect?: Record<string, unknown>;

  /**
   * Required when `id` is provided.
   * Enforces optimistic concurrency on batch updates.
   */
  @IsInt()
  @Min(1)
  @IsOptional()
  expectedVersion?: number;
}

// Batch request

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
  @IsUUID('all', { each: true })
  deletes!: string[];
}
