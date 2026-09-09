import {
  AnnotationNormalizer,
  DEFAULT_ANNOTATION_COLOR,
} from '../../src/modules/library/annotations/normalizers/annotation.normalizer';
import { AnnotationType } from '@prisma/client';

describe('AnnotationNormalizer (Matt Pocock Pattern)', () => {
  let normalizer: AnnotationNormalizer;

  beforeEach(() => {
    normalizer = new AnnotationNormalizer();
  });

  describe('normalizeColor', () => {
    it('accepts valid 6-character hex and converts to lowercase', () => {
      expect(normalizer.normalizeColor('#FF00AA')).toBe('#ff00aa');
      expect(normalizer.normalizeColor('#123456')).toBe('#123456');
    });

    it('accepts valid 3-character hex and converts to lowercase', () => {
      expect(normalizer.normalizeColor('#ABC')).toBe('#abc');
    });

    it('falls back to DEFAULT_ANNOTATION_COLOR on invalid hex', () => {
      expect(normalizer.normalizeColor('invalid-color')).toBe(DEFAULT_ANNOTATION_COLOR);
      expect(normalizer.normalizeColor('#12345')).toBe(DEFAULT_ANNOTATION_COLOR);
      expect(normalizer.normalizeColor('')).toBe(DEFAULT_ANNOTATION_COLOR);
      expect(normalizer.normalizeColor(null)).toBe(DEFAULT_ANNOTATION_COLOR);
      expect(normalizer.normalizeColor(undefined)).toBe(DEFAULT_ANNOTATION_COLOR);
    });
  });

  describe('normalizeCoords', () => {
    it('normalizes standard 4-element coordinates', () => {
      expect(normalizer.normalizeCoords([10, 20, 100, 200])).toEqual([10, 20, 100, 200]);
    });

    it('enforces bounding box order x1 <= x2 and y1 <= y2', () => {
      expect(normalizer.normalizeCoords([100, 200, 10, 20])).toEqual([10, 20, 100, 200]);
    });

    it('returns null for non-array or incorrect length', () => {
      expect(normalizer.normalizeCoords(null)).toBeNull();
      expect(normalizer.normalizeCoords('coords')).toBeNull();
      expect(normalizer.normalizeCoords([1, 2, 3])).toBeNull();
      expect(normalizer.normalizeCoords([1, 2, 3, 4, 5])).toBeNull();
    });

    it('returns null if any element is non-numeric or NaN', () => {
      expect(normalizer.normalizeCoords([1, 'abc', 3, 4])).toBeNull();
      expect(normalizer.normalizeCoords([1, NaN, 3, 4])).toBeNull();
      expect(normalizer.normalizeCoords([1, Infinity, 3, 4])).toBeNull();
    });
  });

  describe('normalizeQuote & normalizeComment', () => {
    it('trims whitespace and replaces CRLF with LF in quote', () => {
      expect(normalizer.normalizeQuote('  hello \r\n world  ')).toBe('hello \n world');
      expect(normalizer.normalizeQuote(null)).toBe('');
    });

    it('trims comment string', () => {
      expect(normalizer.normalizeComment('  important note  ')).toBe('important note');
      expect(normalizer.normalizeComment(undefined)).toBe('');
    });
  });

  describe('parseType', () => {
    it('parses valid AnnotationType strings', () => {
      expect(normalizer.parseType('highlight')).toBe(AnnotationType.highlight);
      expect(normalizer.parseType('underline')).toBe(AnnotationType.underline);
      expect(normalizer.parseType('NOTE')).toBe(AnnotationType.note);
    });

    it('falls back to highlight for invalid or missing type', () => {
      expect(normalizer.parseType('unknown_type')).toBe(AnnotationType.highlight);
      expect(normalizer.parseType(null)).toBe(AnnotationType.highlight);
      expect(normalizer.parseType(undefined)).toBe(AnnotationType.highlight);
    });
  });

  describe('normalizeCreateData & normalizeUpdateData', () => {
    it('normalizes full CreateAnnotationData payload', () => {
      const raw = {
        attachmentId: 'att-1',
        pageIndex: 1,
        color: '#00FF00',
        quoteText: '  Some text \r\n here ',
        comment: '  My comment ',
        rectCoords: [200, 400, 50, 100],
        type: 'UNDERLINE' as any,
        authorId: 'user-1',
      };

      const result = normalizer.normalizeCreateData(raw);

      expect(result.color).toBe('#00ff00');
      expect(result.quoteText).toBe('Some text \n here');
      expect(result.comment).toBe('My comment');
      expect(result.rectCoords).toEqual([50, 100, 200, 400]);
      expect(result.type).toBe(AnnotationType.underline);
    });

    it('normalizes partial UpdateAnnotationData payload', () => {
      const raw = {
        color: 'BAD_COLOR',
        rectCoords: [10, 20, 30, 40],
      };

      const result = normalizer.normalizeUpdateData(raw);

      expect(result.color).toBe(DEFAULT_ANNOTATION_COLOR);
      expect(result.rectCoords).toEqual([10, 20, 30, 40]);
      expect(result.quoteText).toBeUndefined();
    });
  });
});
