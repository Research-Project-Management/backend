import { AnnotationType } from '@prisma/client';
import { RectCoords } from '../types/annotations.types';

export const DEFAULT_ANNOTATION_COLOR = '#ffeb3b';
const HEX_COLOR_REGEX = /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/;

/**
 * Validates and normalizes hex color strings.
 */
export function normalizeAnnotationColor(color?: string | null): string {
  if (!color || typeof color !== 'string') {
    return DEFAULT_ANNOTATION_COLOR;
  }
  const clean = color.trim();
  return HEX_COLOR_REGEX.test(clean)
    ? clean.toLowerCase()
    : DEFAULT_ANNOTATION_COLOR;
}

/**
 * Validates whether rectCoords matches standard PDF rectangle format: [x1, y1, x2, y2].
 */
export function normalizeRectCoords(coords: unknown): RectCoords | null {
  if (!Array.isArray(coords) || coords.length !== 4) {
    return null;
  }
  const numeric = coords.map((c) => Number(c));
  if (numeric.some((n) => isNaN(n) || !isFinite(n))) {
    return null;
  }
  return numeric as RectCoords;
}

/**
 * Normalizes annotation quote text, removing excessive whitespace.
 */
export function normalizeQuoteText(text?: string | null): string {
  if (!text || typeof text !== 'string') return '';
  return text.trim().replace(/\r\n/g, '\n');
}

/**
 * Normalizes annotation comment string.
 */
export function normalizeComment(comment?: string | null): string {
  if (!comment || typeof comment !== 'string') return '';
  return comment.trim();
}

/**
 * Safely parses and normalizes annotation type string into AnnotationType enum.
 */
export function parseAnnotationType(type?: string | null): AnnotationType {
  if (!type || typeof type !== 'string') {
    return AnnotationType.highlight;
  }
  const normalized = type.trim().toLowerCase();
  const validTypes = Object.values(AnnotationType) as string[];
  if (validTypes.includes(normalized)) {
    return normalized as AnnotationType;
  }
  return AnnotationType.highlight;
}

// Abstract, concise, direct aliases
export const normalizeColor = normalizeAnnotationColor;
export const normalizeCoords = normalizeRectCoords;
export const normalizeQuote = normalizeQuoteText;
export const parseType = parseAnnotationType;
export const DEFAULT_COLOR = DEFAULT_ANNOTATION_COLOR;

