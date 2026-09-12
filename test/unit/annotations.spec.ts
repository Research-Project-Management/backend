import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AnnotationType } from '@prisma/client';
import { AnnotationsService } from '../../src/modules/library/annotations/annotations.service';
import { AnnotationsRepository } from '../../src/modules/library/annotations/annotations.repository';
import {
  normalizeAnnotationColor,
  normalizeQuoteText,
  normalizeComment,
  normalizeRectCoords,
  parseAnnotationType,
  DEFAULT_ANNOTATION_COLOR,
} from '../../src/modules/library/annotations/utils/annotations.utils';
import { VersionMismatchException } from '../../src/modules/library/core/errors/version-mismatch.exception';

describe('Annotation Module Unit Tests', () => {
  describe('Annotation Utilities (Pure Functions)', () => {
    it('normalizes hex colors correctly and falls back to default', () => {
      expect(normalizeAnnotationColor('#ffeb3b')).toBe('#ffeb3b');
      expect(normalizeAnnotationColor('#FFF')).toBe('#fff');
      expect(normalizeAnnotationColor(' #10b981 ')).toBe('#10b981');
      expect(normalizeAnnotationColor('invalid-color')).toBe(
        DEFAULT_ANNOTATION_COLOR,
      );
      expect(normalizeAnnotationColor('')).toBe(DEFAULT_ANNOTATION_COLOR);
      expect(normalizeAnnotationColor(null as any)).toBe(
        DEFAULT_ANNOTATION_COLOR,
      );
      expect(normalizeAnnotationColor(undefined)).toBe(
        DEFAULT_ANNOTATION_COLOR,
      );
    });

    it('normalizes quote text and cleans up carriage returns', () => {
      expect(normalizeQuoteText('  Hello\r\nWorld  ')).toBe('Hello\nWorld');
      expect(normalizeQuoteText('')).toBe('');
      expect(normalizeQuoteText(null)).toBe('');
      expect(normalizeQuoteText(undefined)).toBe('');
    });

    it('normalizes comment strings', () => {
      expect(normalizeComment('  Important note  ')).toBe('Important note');
      expect(normalizeComment('')).toBe('');
      expect(normalizeComment(null)).toBe('');
      expect(normalizeComment(undefined)).toBe('');
    });

    it('validates and normalizes 4-number PDF rectCoords', () => {
      expect(normalizeRectCoords([0.1, 0.2, 0.3, 0.4])).toEqual([
        0.1, 0.2, 0.3, 0.4,
      ]);
      expect(normalizeRectCoords(['0.1', '0.2', '0.3', '0.4'])).toEqual([
        0.1, 0.2, 0.3, 0.4,
      ]);
      expect(normalizeRectCoords([0.1, 0.2, 0.3])).toBeNull();
      expect(normalizeRectCoords([0.1, 0.2, 0.3, 0.4, 0.5])).toBeNull();
      expect(normalizeRectCoords([0.1, 'invalid', 0.3, 0.4])).toBeNull();
      expect(normalizeRectCoords(null)).toBeNull();
      expect(normalizeRectCoords({ x: 1, y: 2 })).toBeNull();
    });

    it('safely parses annotation type strings into AnnotationType enum', () => {
      expect(parseAnnotationType('highlight')).toBe(AnnotationType.highlight);
      expect(parseAnnotationType('UNDERLINE')).toBe(AnnotationType.underline);
      expect(parseAnnotationType('note')).toBe(AnnotationType.note);
      expect(parseAnnotationType('rect')).toBe(AnnotationType.rect);
      expect(parseAnnotationType('image')).toBe(AnnotationType.image);
      expect(parseAnnotationType('unknown_type')).toBe(
        AnnotationType.highlight,
      );
      expect(parseAnnotationType(null)).toBe(AnnotationType.highlight);
      expect(parseAnnotationType(undefined)).toBe(AnnotationType.highlight);
    });
  });

  describe('AnnotationsRepository (Optimistic Concurrency & Redundancy Prevention)', () => {
    let mockPrisma: any;
    let repo: AnnotationsRepository;

    beforeEach(() => {
      mockPrisma = {
        annotation: {
          findMany: jest.fn(),
          findFirst: jest.fn(),
          create: jest.fn(),
          update: jest.fn(),
          updateMany: jest.fn(),
        },
      };
      repo = new AnnotationsRepository(mockPrisma);
    });

    it('throws VersionMismatchException when updating with mismatched version', async () => {
      const existing = {
        id: 'anno-1',
        version: 2,
        color: '#ffeb3b',
        quoteText: 'old text',
        comment: 'old comment',
        rectCoords: null,
      };

      await expect(
        repo.update(
          'anno-1',
          1,
          { comment: 'new comment' },
          undefined,
          existing as any,
        ),
      ).rejects.toThrow(VersionMismatchException);

      expect(mockPrisma.annotation.update).not.toHaveBeenCalled();
    });

    it('updates successfully when version matches and skips redundant findById when existingAnnotation is passed', async () => {
      const existing = {
        id: 'anno-1',
        version: 2,
        color: '#ffeb3b',
        quoteText: 'old text',
        comment: 'old comment',
        rectCoords: null,
      };

      mockPrisma.annotation.update.mockResolvedValueOnce({
        ...existing,
        version: 3,
        comment: 'new comment',
      });

      const updated = await repo.update(
        'anno-1',
        2,
        { comment: 'new comment' },
        undefined,
        existing as any,
      );

      // Verify findFirst was NOT called because existingAnnotation was passed directly!
      expect(mockPrisma.annotation.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.annotation.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'anno-1' },
          data: expect.objectContaining({
            comment: 'new comment',
            version: { increment: 1 },
          }),
        }),
      );
      expect(updated.version).toBe(3);
    });

    it('throws VersionMismatchException when soft deleting with mismatched version', async () => {
      const existing = {
        id: 'anno-1',
        version: 3,
      };

      await expect(
        repo.softDelete('anno-1', 2, undefined, existing as any),
      ).rejects.toThrow(VersionMismatchException);

      expect(mockPrisma.annotation.updateMany).not.toHaveBeenCalled();
    });

    it('soft deletes successfully when version matches, skipping redundant findById', async () => {
      const existing = {
        id: 'anno-1',
        version: 3,
      };

      mockPrisma.annotation.updateMany.mockResolvedValueOnce({ count: 1 });

      const deleted = await repo.softDelete(
        'anno-1',
        3,
        undefined,
        existing as any,
      );

      expect(mockPrisma.annotation.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.annotation.updateMany).toHaveBeenCalledWith({
        where: { id: 'anno-1', deletedAt: null },
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      });
      expect(deleted).toBe(true);
    });
  });

  describe('AnnotationsService (Business Logic & Authorization)', () => {
    let service: AnnotationsService;
    let mockRepo: any;
    let mockTxService: any;
    let mockAttachmentsService: any;
    let mockPrisma: any;

    const workspaceId = '00000000-0000-0000-0000-000000000001';
    const attachmentId = '11111111-1111-1111-1111-111111111111';
    const authorId = '22222222-2222-2222-2222-222222222222';
    const otherUserId = '33333333-3333-3333-3333-333333333333';

    beforeEach(() => {
      mockRepo = {
        findById: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        softDelete: jest.fn(),
        findByAttachment: jest.fn(),
      };
      mockPrisma = {
        workspaceMember: {
          findUnique: jest.fn(),
        },
        workspace: {
          findFirst: jest.fn().mockResolvedValue(null), // default: not owner
        },
      };
      mockTxService = {
        executeInTransaction: jest.fn(async (cb) => {
          const fakeTx = {
            workspaceMember: mockPrisma.workspaceMember,
            workspace: mockPrisma.workspace,
          };
          const fakeHelpers = {
            appendChange: jest.fn().mockResolvedValue(undefined),
            publishOutbox: jest.fn().mockResolvedValue(undefined),
            recordTombstone: jest.fn().mockResolvedValue(undefined),
          };
          return cb(fakeTx, fakeHelpers);
        }),
      };

      mockAttachmentsService = {
        assertAttachmentExists: jest.fn().mockResolvedValue(undefined),
      };
      service = new AnnotationsService(
        mockRepo,
        mockTxService,
        mockAttachmentsService,
      );
    });

    it('allows author to update annotation', async () => {
      const existing = {
        id: 'anno-1',
        attachmentId,
        authorId,
        version: 1,
      };
      mockRepo.findById.mockResolvedValueOnce(existing);
      mockRepo.update.mockResolvedValueOnce({
        ...existing,
        version: 2,
        comment: 'updated',
      });

      const result = await service.updateAnnotation(
        authorId,
        'anno-1',
        1,
        { comment: 'updated' },
      );
      expect(result.version).toBe(2);
    });

    it('forbids non-author from updating another user\'s annotation', async () => {
      const existing = {
        id: 'anno-1',
        attachmentId,
        authorId,
        version: 1,
      };
      mockRepo.findById.mockResolvedValueOnce(existing);

      await expect(
        service.updateAnnotation(
          otherUserId,
          'anno-1',
          1,
          { comment: 'unauthorized edit' },
        ),
      ).rejects.toThrow(ForbiddenException);

      expect(mockRepo.update).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when updating non-existent annotation', async () => {
      mockRepo.findById.mockResolvedValueOnce(null);

      await expect(
        service.updateAnnotation(authorId, 'non-existent', 1, {}),
      ).rejects.toThrow(NotFoundException);
    });

    it('normalizes color, quoteText, and comment when creating annotation', async () => {
      mockRepo.create.mockImplementationOnce((data: any) =>
        Promise.resolve({ id: 'anno-new', version: 1, ...data }),
      );

      await service.createAnnotation(workspaceId, {
        attachmentId,
        authorId,
        pageIndex: 0,
        color: 'invalid',
        quoteText: '  Line 1\r\nLine 2  ',
        comment: '  My Comment  ',
      });

      expect(mockRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          color: DEFAULT_ANNOTATION_COLOR,
          quoteText: 'Line 1\nLine 2',
          comment: 'My Comment',
        }),
        expect.anything(),
      );
    });
  });
});

// ─── Sort Index Pure Function Tests ──────────────────────────────────────────

import {
  buildAnnotationSortIndex,
  parseAnnotationSortIndex,
  compareSortIndex,
} from '../../src/modules/library/annotations/utils/sort-index.util';

describe('buildAnnotationSortIndex', () => {
  it('returns padded zeros for page 0 with no coordinates', () => {
    expect(buildAnnotationSortIndex(0)).toBe('0000|00000|00000');
  });

  it('pads single-digit page index correctly', () => {
    expect(buildAnnotationSortIndex(1)).toBe('0001|00000|00000');
  });

  it('handles max page (9999)', () => {
    expect(buildAnnotationSortIndex(9999)).toBe('9999|00000|00000');
  });

  it('encodes y=0.5, x=0.3 correctly', () => {
    expect(buildAnnotationSortIndex(1, 0.5, 0.3)).toBe('0001|05000|03000');
  });

  it('rounds floating point coordinates', () => {
    expect(buildAnnotationSortIndex(0, 0.12345, 0.9999)).toBe('0000|01235|09999');
  });

  it('clamps negative coordinates to 0', () => {
    expect(buildAnnotationSortIndex(0, -0.1, -5)).toBe('0000|00000|00000');
  });
});

describe('sort order via compareSortIndex', () => {
  it('page 1 sorts after page 0', () => {
    const a = buildAnnotationSortIndex(0);
    const b = buildAnnotationSortIndex(1);
    expect(compareSortIndex(a, b)).toBeLessThan(0);
  });

  it('same page: higher Y sorts after lower Y', () => {
    const top    = buildAnnotationSortIndex(0, 0.1);
    const bottom = buildAnnotationSortIndex(0, 0.9);
    expect(compareSortIndex(top, bottom)).toBeLessThan(0);
  });

  it('same page, same Y: higher X sorts after lower X', () => {
    const left  = buildAnnotationSortIndex(0, 0.5, 0.1);
    const right = buildAnnotationSortIndex(0, 0.5, 0.9);
    expect(compareSortIndex(left, right)).toBeLessThan(0);
  });

  it('array sorts correctly across pages and positions', () => {
    const keys = [
      buildAnnotationSortIndex(2, 0.1, 0.0),
      buildAnnotationSortIndex(0, 0.9, 0.9),
      buildAnnotationSortIndex(1, 0.5, 0.5),
      buildAnnotationSortIndex(0, 0.1, 0.0),
    ];
    const sorted = [...keys].sort(compareSortIndex);
    expect(sorted).toEqual([
      buildAnnotationSortIndex(0, 0.1, 0.0),
      buildAnnotationSortIndex(0, 0.9, 0.9),
      buildAnnotationSortIndex(1, 0.5, 0.5),
      buildAnnotationSortIndex(2, 0.1, 0.0),
    ]);
  });
});

describe('parseAnnotationSortIndex', () => {
  it('parses a valid sort index', () => {
    const result = parseAnnotationSortIndex('0001|05000|03000');
    expect(result).toEqual({ page: 1, y: 0.5, x: 0.3 });
  });

  it('returns null for invalid format', () => {
    expect(parseAnnotationSortIndex('invalid')).toBeNull();
    expect(parseAnnotationSortIndex('0001|05000')).toBeNull();
    expect(parseAnnotationSortIndex('abc|def|ghi')).toBeNull();
  });

  it('round-trips through build → parse', () => {
    const sortIndex = buildAnnotationSortIndex(3, 0.25, 0.75);
    const parsed    = parseAnnotationSortIndex(sortIndex);
    expect(parsed?.page).toBe(3);
    expect(parsed?.y).toBeCloseTo(0.25, 4);
    expect(parsed?.x).toBeCloseTo(0.75, 4);
  });
});
