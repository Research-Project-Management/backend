import { Injectable } from '@nestjs/common';
import {
  AnnotationType,
  RectCoords,
  CreateAnnotationData,
  UpdateAnnotationData,
} from '@/modules/library/extraction/types/extraction.types';
import { normalizeAcademicTags } from '@/modules/library/core/domain/tag.domain';

export const DEFAULT_ANNOTATION_COLOR = '#ffd400';
const HEX_COLOR_REGEX = /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/;

export interface NormalizedRectBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
  height: number;
}

/**
 * Extracts canonical top-left anchor { x1, y1 } from either a 4-number tuple [x1, y1, x2, y2],
 * an array of rect objects [{ x1, y1, ... }], or a single rect object.
 */
export function extractTopLeftAnchor(
  rectCoords: unknown,
): { x1: number; y1: number } | null {
  if (!rectCoords) return null;
  if (Array.isArray(rectCoords)) {
    if (rectCoords.length === 0) return null;
    if (
      rectCoords.length === 4 &&
      rectCoords.every((c) => typeof c === 'number' && Number.isFinite(c))
    ) {
      const [x1, y1, x2, y2] = rectCoords as [number, number, number, number];
      return { x1: Math.min(x1, x2), y1: Math.min(y1, y2) };
    }
    const first = rectCoords[0];
    if (first && typeof first === 'object' && !Array.isArray(first)) {
      const r = first as Record<string, unknown>;
      const rawX = Number(r.x1 ?? r.x);
      const rawY = Number(r.y1 ?? r.y);
      if (Number.isFinite(rawX) && Number.isFinite(rawY)) {
        return { x1: rawX, y1: rawY };
      }
    }
    return null;
  }
  if (typeof rectCoords === 'object') {
    const r = rectCoords as Record<string, unknown>;
    const rawX = Number(r.x1 ?? r.x);
    const rawY = Number(r.y1 ?? r.y);
    if (Number.isFinite(rawX) && Number.isFinite(rawY)) {
      return { x1: rawX, y1: rawY };
    }
  }
  return null;
}

/**
 * Normalizes a single rect item (4-number tuple or object) into a canonical NormalizedRectBox.
 */
export function normalizeSingleRectBox(
  item: unknown,
): NormalizedRectBox | null {
  if (
    Array.isArray(item) &&
    item.length === 4 &&
    item.every((n) => typeof n === 'number')
  ) {
    const [x1, y1, x2, y2] = item as [number, number, number, number];
    return {
      x1,
      y1,
      x2,
      y2,
      width: Math.max(0, x2 - x1),
      height: Math.max(0, y2 - y1),
    };
  }
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    const r = item as Record<string, unknown>;
    const x1 =
      typeof r.x1 === 'number'
        ? r.x1
        : typeof r.x === 'number'
          ? r.x
          : undefined;
    const y1 =
      typeof r.y1 === 'number'
        ? r.y1
        : typeof r.y === 'number'
          ? r.y
          : undefined;
    const w = typeof r.width === 'number' ? r.width : undefined;
    const h = typeof r.height === 'number' ? r.height : undefined;
    const x2 =
      typeof r.x2 === 'number'
        ? r.x2
        : x1 !== undefined && w !== undefined
          ? x1 + w
          : undefined;
    const y2 =
      typeof r.y2 === 'number'
        ? r.y2
        : y1 !== undefined && h !== undefined
          ? y1 + h
          : undefined;
    if (
      x1 !== undefined &&
      y1 !== undefined &&
      x2 !== undefined &&
      y2 !== undefined
    ) {
      return {
        x1,
        y1,
        x2,
        y2,
        width: w ?? Math.max(0, x2 - x1),
        height: h ?? Math.max(0, y2 - y1),
      };
    }
  }
  return null;
}

/**
 * Normalizes arbitrary rectCoords JSON into an array of NormalizedRectBox objects.
 */
export function normalizeRectCoordsToBoxes(
  rc: unknown,
): NormalizedRectBox[] {
  const rects: NormalizedRectBox[] = [];
  if (Array.isArray(rc)) {
    if (rc.length === 4 && rc.every((n) => typeof n === 'number')) {
      const single = normalizeSingleRectBox(rc);
      if (single) rects.push(single);
    } else {
      for (const entry of rc) {
        const mapped = normalizeSingleRectBox(entry);
        if (mapped) rects.push(mapped);
      }
    }
  } else if (rc && typeof rc === 'object') {
    const single = normalizeSingleRectBox(rc);
    if (single) rects.push(single);
  }
  return rects;
}

/**
 * AnnotationNormalizer — Deep Module for annotation payload formatting,
 * coordinate bounding box validation, and sanitize processing.
 */
@Injectable()
export class AnnotationNormalizer {
  /**
   * Validates and normalizes hex color strings to lowercase canonical form.
   */
  normalizeColor(color?: string | null): string {
    if (!color || typeof color !== 'string') {
      return DEFAULT_ANNOTATION_COLOR;
    }
    const clean = color.trim();
    return HEX_COLOR_REGEX.test(clean)
      ? clean.toLowerCase()
      : DEFAULT_ANNOTATION_COLOR;
  }

  /**
   * Validates whether rectCoords matches standard PDF rectangle format [x1, y1, x2, y2]
   * or an array of normalized bounding box objects [{ x1, y1, x2, y2, width?, height? }].
   * Normalizes bounding box order so x1 <= x2 and y1 <= y2.
   */
  normalizeCoords(coords: unknown):
    | RectCoords
    | Array<{
        x1: number;
        y1: number;
        x2: number;
        y2: number;
        width: number;
        height: number;
      }>
    | null {
    if (!Array.isArray(coords) || coords.length === 0) {
      return null;
    }

    // Format 1: 4-number tuple [x1, y1, x2, y2]
    if (
      coords.length === 4 &&
      coords.every((c) => typeof c === 'number' || typeof c === 'string')
    ) {
      const numeric = coords.map((c) => Number(c));
      if (numeric.some((n) => isNaN(n) || !isFinite(n))) {
        return null;
      }

      const [rawX1, rawY1, rawX2, rawY2] = numeric;
      const x1 = Math.min(rawX1, rawX2);
      const x2 = Math.max(rawX1, rawX2);
      const y1 = Math.min(rawY1, rawY2);
      const y2 = Math.max(rawY1, rawY2);

      return [x1, y1, x2, y2] as RectCoords;
    }

    // Format 2: Array of rect objects [{ x1, y1, x2?, y2?, width?, height? }]
    const normalizedRects: Array<{
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      width: number;
      height: number;
    }> = [];

    for (const item of coords) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return null;
      }
      const r = item as Record<string, unknown>;
      const rawX1 = Number(r.x1 ?? r.x);
      const rawY1 = Number(r.y1 ?? r.y);
      const rawX2 =
        r.x2 !== undefined
          ? Number(r.x2)
          : r.width !== undefined
            ? rawX1 + Number(r.width)
            : NaN;
      const rawY2 =
        r.y2 !== undefined
          ? Number(r.y2)
          : r.height !== undefined
            ? rawY1 + Number(r.height)
            : NaN;

      if ([rawX1, rawY1, rawX2, rawY2].some((n) => isNaN(n) || !isFinite(n))) {
        return null;
      }

      const x1 = Math.min(rawX1, rawX2);
      const x2 = Math.max(rawX1, rawX2);
      const y1 = Math.min(rawY1, rawY2);
      const y2 = Math.max(rawY1, rawY2);

      normalizedRects.push({
        x1,
        y1,
        x2,
        y2,
        width: x2 - x1,
        height: y2 - y1,
      });
    }

    return normalizedRects.length > 0 ? normalizedRects : null;
  }

  /**
   * Normalizes annotation quote text, removing excessive whitespace and CRLF.
   */
  normalizeQuote(text?: string | null): string {
    if (!text || typeof text !== 'string') return '';
    return (
      text
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x1F\x7F]/g, (c) => (c === '\n' || c === '\t' ? c : ''))
        .trim()
        .replace(/\r\n/g, '\n')
    );
  }

  /**
   * Normalizes and sanitizes annotation comment string.
   */
  normalizeComment(comment?: string | null): string {
    if (!comment || typeof comment !== 'string') return '';
    return (
      comment
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, '')
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x1F\x7F]/g, '')
        .trim()
    );
  }

  /**
   * Safely parses and normalizes annotation type string into AnnotationType enum.
   */
  parseType(type?: string | null): AnnotationType;
  parseType<T extends AnnotationType | null>(
    type: string | null | undefined,
    fallback: T,
  ): AnnotationType | T;
  parseType(
    type?: string | null,
    fallback: AnnotationType | null = AnnotationType.highlight,
  ): AnnotationType | null {
    if (!type || typeof type !== 'string') {
      return fallback;
    }
    const normalized = type.trim().toLowerCase();
    if (
      normalized === 'box' ||
      normalized === 'area' ||
      normalized === 'image' ||
      normalized === 'square' ||
      normalized === 'circle' ||
      normalized === 'line' ||
      normalized === 'rect'
    ) {
      return AnnotationType.rect;
    }
    if (
      normalized === 'strike' ||
      normalized === 'strikeout' ||
      normalized === 'strikethrough'
    ) {
      return AnnotationType.strike;
    }
    if (normalized === 'text' || normalized === 'freetext') {
      return AnnotationType.text;
    }
    if (
      normalized === 'ink' ||
      normalized === 'drawing' ||
      normalized === 'pen'
    ) {
      return AnnotationType.ink;
    }
    const validTypes = Object.values(AnnotationType) as string[];
    if (validTypes.includes(normalized)) {
      return normalized as AnnotationType;
    }
    return fallback;
  }

  /**
   * Normalizes annotation tags array using canonical tag normalizer.
   */
  normalizeTags(tags?: unknown): string[] {
    if (!Array.isArray(tags)) return [];
    return normalizeAcademicTags(
      tags.filter((t): t is string => typeof t === 'string'),
    );
  }

  /**
   * Normalizes complete CreateAnnotationData payload.
   */
  normalizeCreateData(data: CreateAnnotationData) {
    return {
      ...data,
      color: this.normalizeColor(data.color),
      quoteText: this.normalizeQuote(data.quoteText),
      comment: this.normalizeComment(data.comment),
      tags: this.normalizeTags(data.tags),
      rectCoords:
        data.rectCoords !== undefined
          ? this.normalizeCoords(data.rectCoords)
          : null,
      type: this.parseType(data.type),
    };
  }

  /**
   * Normalizes complete UpdateAnnotationData payload.
   */
  normalizeUpdateData(data: UpdateAnnotationData) {
    const payload: Partial<UpdateAnnotationData> = { ...data };

    if (data.color !== undefined) {
      payload.color = this.normalizeColor(data.color);
    }
    if (data.quoteText !== undefined) {
      payload.quoteText = this.normalizeQuote(data.quoteText);
    }
    if (data.comment !== undefined) {
      payload.comment = this.normalizeComment(data.comment);
    }
    if (data.tags !== undefined) {
      payload.tags = this.normalizeTags(data.tags);
    }
    if (data.rectCoords !== undefined) {
      payload.rectCoords = this.normalizeCoords(data.rectCoords);
    }

    return payload;
  }
}
