import { Injectable } from '@nestjs/common';
import { AnnotationType } from '@prisma/client';
import {
  RectCoords,
  CreateAnnotationData,
  UpdateAnnotationData,
} from '../types/annotations.types';

export const DEFAULT_ANNOTATION_COLOR = '#ffeb3b';
const HEX_COLOR_REGEX = /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/;

/**
 * AnnotationNormalizer — Deep Module for annotation payload formatting,
 * coordinate bounding box validation, and sanitize processing (Matt Pocock Pattern).
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
   * Validates whether rectCoords matches standard PDF rectangle format [x1, y1, x2, y2].
   * Normalizes bounding box order so x1 <= x2 and y1 <= y2.
   */
  normalizeCoords(coords: unknown): RectCoords | null {
    if (!Array.isArray(coords) || coords.length !== 4) {
      return null;
    }
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

  /**
   * Normalizes annotation quote text, removing excessive whitespace and CRLF.
   */
  normalizeQuote(text?: string | null): string {
    if (!text || typeof text !== 'string') return '';
    return text.trim().replace(/\r\n/g, '\n');
  }

  /**
   * Normalizes annotation comment string.
   */
  normalizeComment(comment?: string | null): string {
    if (!comment || typeof comment !== 'string') return '';
    return comment.trim();
  }

  /**
   * Safely parses and normalizes annotation type string into AnnotationType enum.
   */
  parseType(type?: string | null): AnnotationType {
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

  /**
   * Normalizes complete CreateAnnotationData payload.
   */
  normalizeCreateData(data: CreateAnnotationData) {
    return {
      ...data,
      color: this.normalizeColor(data.color),
      quoteText: this.normalizeQuote(data.quoteText),
      comment: this.normalizeComment(data.comment),
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
    if (data.rectCoords !== undefined) {
      payload.rectCoords = this.normalizeCoords(data.rectCoords);
    }

    return payload;
  }
}
