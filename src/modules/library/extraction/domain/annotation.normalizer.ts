import { Injectable } from '@nestjs/common';
import {
  AnnotationType,
  RectCoords,
  CreateAnnotationData,
  UpdateAnnotationData,
} from '@/modules/library/extraction/types/annotations.types';
import { normalizeAcademicTags } from '@/modules/library/core/domain/tag.domain';

export const DEFAULT_ANNOTATION_COLOR = '#ffeb3b';
const HEX_COLOR_REGEX = /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/;

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
  parseType(type?: string | null): AnnotationType {
    if (!type || typeof type !== 'string') {
      return AnnotationType.highlight;
    }
    const normalized = type.trim().toLowerCase();
    if (normalized === 'box' || normalized === 'area') {
      return AnnotationType.rect;
    }
    if (normalized === 'strike' || normalized === 'strikethrough') {
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
    return AnnotationType.highlight;
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
