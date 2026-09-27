import {
  AnnotationType,
  RectCoords,
} from '../../domain/types/annotations.types';
import {
  AnnotationNormalizer,
  DEFAULT_ANNOTATION_COLOR,
} from '../normalizers/annotation.normalizer';

const normalizer = new AnnotationNormalizer();

export { DEFAULT_ANNOTATION_COLOR };

export function normalizeAnnotationColor(color?: string | null): string {
  return normalizer.normalizeColor(color);
}

export function normalizeRectCoords(coords: unknown): RectCoords | null {
  return normalizer.normalizeCoords(coords);
}

export function normalizeQuoteText(text?: string | null): string {
  return normalizer.normalizeQuote(text);
}

export function normalizeComment(comment?: string | null): string {
  return normalizer.normalizeComment(comment);
}

export function parseAnnotationType(type?: string | null): AnnotationType {
  return normalizer.parseType(type);
}

// Canonical aliases
export const normalizeColor = normalizeAnnotationColor;
export const normalizeCoords = normalizeRectCoords;
export const normalizeQuote = normalizeQuoteText;
export const parseType = parseAnnotationType;
export const DEFAULT_COLOR = DEFAULT_ANNOTATION_COLOR;
