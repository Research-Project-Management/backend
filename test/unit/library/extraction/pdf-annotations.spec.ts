jest.mock('unpdf', () => ({
  getDocumentProxy: jest.fn(),
}));

import {
  BadRequestException,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { AnnotationType } from '@prisma/client';
import { fromPartial } from '@total-typescript/shoehorn';
import { getDocumentProxy } from 'unpdf';
import { AnnotationNormalizer } from '@/modules/library/extraction/domain/annotations.domain';
import {
  CreateAnnotationDto,
  UpdateAnnotationDto,
  BatchAnnotationsDto,
} from '@/modules/library/extraction/dto/annotations.dto';
import { AnnotationsRepository } from '@/modules/library/extraction/repositories/annotations.repository';
import { AnnotationsService } from '@/modules/library/extraction/services/annotations.service';
import { AttachmentsService } from '@/modules/library/extraction/services/attachments.service';
import { PdfAnnotationImporterService } from '@/modules/library/extraction/services/pdf-annotations.service';
import { PrismaService } from '@/core';

describe('PDF Annotations — Normalizer, DTO Pipe, Scoping & /Annots Importer', () => {
  const mockGetDocumentProxy = getDocumentProxy as jest.MockedFunction<
    typeof getDocumentProxy
  >;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('AnnotationNormalizer, DTO ValidationPipe & Repository/Service Invariants', () => {
    it('normalizes highlights, hex colors, HTML comments, sorted rectCoords, and image annotation types', () => {
      const normalizer = new AnnotationNormalizer();
      const created = normalizer.normalizeCreateData({
        type: 'highlight',
        color: '#FFEB3B',
        pageIndex: 2,
        pageLabel: 'iii',
        quoteText:
          'Self-attention relates different positions of a single sequence.',
        comment:
          'Core definition of <b>self-attention</b><script>evil()</script>',
        tags: ['  Self-Attention ', 'self-attention'],
        rectCoords: [480.0, 524.8, 72.5, 512.3],
      });

      expect(created).toMatchObject({
        type: 'highlight',
        color: '#ffeb3b',
        pageIndex: 2,
        comment: 'Core definition of self-attention',
        rectCoords: [72.5, 512.3, 480.0, 524.8],
      });
      expect(normalizer.parseType('image')).toBe('image');
    });

    it('preserves rects, rectCoords, boundingRect, and ink paths under NestJS ValidationPipe whitelist + implicit conversion', async () => {
      const pipe = new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: false,
        stopAtFirstError: true,
        transformOptions: { enableImplicitConversion: true },
      });
      const box = {
        x1: 0.12,
        y1: 0.24,
        x2: 0.68,
        y2: 0.29,
        width: 0.56,
        height: 0.05,
      };
      const inkBox = {
        ...box,
        paths: [
          [
            [0.12, 0.24],
            [0.4, 0.27],
          ],
        ],
      };

      const created = await pipe.transform(
        {
          type: 'highlight',
          pageIndex: 0,
          color: '#ffd400',
          rects: [box],
        },
        { type: 'body', metatype: CreateAnnotationDto },
      );
      expect(created.rects).toEqual([box]);

      const updated = await pipe.transform(
        { rects: [box], boundingRect: box, expectedVersion: 1 },
        { type: 'body', metatype: UpdateAnnotationDto },
      );
      expect(updated.boundingRect).toEqual(box);

      const batched = await pipe.transform(
        {
          upserts: [{ type: 'ink', pageIndex: 0, rects: [inkBox] }],
          deletes: [],
        },
        { type: 'body', metatype: BatchAnnotationsDto },
      );
      expect(batched.upserts[0].rects).toEqual([inkBox]);
    });

    it('omits rectCoords from SQL UPDATE when only comment changes and inherits parent item projectId on create/delete', async () => {
      const updateMany = jest.fn().mockResolvedValue({ count: 1 });
      const annRepo = new AnnotationsRepository({
        annotation: { updateMany },
      } as unknown as PrismaService);

      await annRepo.update(
        'ann-1',
        1,
        { comment: 'Updated comment only' },
        undefined,
        {
          id: 'ann-1',
          attachmentId: 'att-1',
          type: 'image',
          pageIndex: 1,
          pageLabel: '1',
          annotationSortIndex: '0001|01000|01000',
          color: '#ffd400',
          quoteText: '',
          comment: 'Initial',
          tags: [],
          rectCoords: [
            { x1: 0.1, y1: 0.1, x2: 0.5, y2: 0.5, width: 0.4, height: 0.4 },
          ],
          authorId: 'user-1',
          version: 1,
          deletedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      );
      expect('rectCoords' in updateMany.mock.calls[0][0].data).toBe(false);

      const userId = '11111111-1111-4111-8111-111111111111';
      const projectId = '22222222-2222-4222-8222-222222222222';
      const attachmentId = '44444444-4444-4444-8444-444444444444';
      const annotationId = '66666666-6666-4666-8666-666666666666';

      const helpers = {
        appendChange: jest.fn().mockResolvedValue({}),
        recordTombstone: jest.fn().mockResolvedValue({}),
        publishOutbox: jest.fn().mockResolvedValue({}),
      };
      const service = new AnnotationsService(
        fromPartial<AnnotationsRepository>({
          create: jest.fn().mockResolvedValue({ id: annotationId, version: 1 }),
          findById: jest.fn().mockResolvedValue({
            id: annotationId,
            attachmentId,
            authorId: userId,
          }),
          softDelete: jest.fn().mockResolvedValue(true),
        }),
        {
          executeInTransaction: jest.fn(
            (cb: (tx: unknown, h: typeof helpers) => unknown) =>
              cb({}, helpers),
          ),
        } as never,
        fromPartial<AttachmentsService>({
          assertAttachmentExists: jest.fn().mockResolvedValue({
            id: attachmentId,
            item: { id: 'item-1', projectId },
          }),
        }),
        new AnnotationNormalizer(),
      );

      await service.createAnnotation(userId, {
        authorId: userId,
        attachmentId,
        pageIndex: 1,
        quoteText: 'Deep neural networks',
      });
      expect(helpers.appendChange).toHaveBeenCalledWith(
        { userId, projectId },
        expect.objectContaining({
          entityType: 'Annotation',
          entityId: annotationId,
          action: 'create',
        }),
      );

      await service.deleteAnnotation(userId, annotationId);
      expect(helpers.recordTombstone).toHaveBeenCalledWith(
        { userId, projectId },
        expect.objectContaining({
          entityType: 'Annotation',
          entityId: annotationId,
        }),
      );
    });
  });

  describe('PdfAnnotationImporterService (/Annots Import)', () => {
    it('validates attachment/file existence, converts PDF bottom-left coordinates to normalized [0,1] top-left rects, and deduplicates existing annotations', async () => {
      const mockAnnotationsRepo = {
        findExistingForImport: jest.fn().mockResolvedValue([]),
      };
      const mockAttachmentsRepo = {
        findUnique: jest.fn(),
        checkProjectMember: jest.fn().mockResolvedValue(true),
      };
      const mockStoragePort = {
        readOwnedFile: jest.fn().mockResolvedValue({
          buffer: Buffer.from('%PDF-1.4 mock'),
        }),
      };
      const mockAnnotationsService = {
        batchUpsertAnnotations: jest
          .fn()
          .mockImplementation(
            (_u: string, _a: string, data: { upserts?: unknown[] }) =>
              Promise.resolve({
                created: (data.upserts || []).map((u, idx) => ({
                  id: `anno-${idx}`,
                  ...(u as object),
                })),
                updated: [],
                deleted: [],
              }),
          ),
      };

      const importer = new PdfAnnotationImporterService(
        mockAnnotationsRepo as never,
        mockAttachmentsRepo as never,
        mockStoragePort as never,
        mockAnnotationsService as never,
      );

      mockAttachmentsRepo.findUnique.mockResolvedValueOnce(null);
      await expect(
        importer.importFromAttachment('user-1', 'missing'),
      ).rejects.toThrow(NotFoundException);

      mockAttachmentsRepo.findUnique.mockResolvedValueOnce({
        id: 'att-1',
        fileId: null,
        file: null,
      });
      await expect(
        importer.importFromAttachment('user-1', 'att-1'),
      ).rejects.toThrow(BadRequestException);

      mockAttachmentsRepo.findUnique.mockResolvedValue({
        id: 'att-1',
        fileId: 'file-100',
      });
      mockGetDocumentProxy.mockResolvedValue({
        numPages: 1,
        getPage: jest.fn().mockResolvedValue({
          getViewport: () => ({ width: 500, height: 1000 }),
          getAnnotations: jest.fn().mockResolvedValue([
            {
              subtype: 'Highlight',
              rect: [50, 700, 250, 750],
              contents: 'Important research finding',
              color: [1, 0.83, 0],
            },
            {
              subtype: 'StrikeOut',
              rect: [50, 500, 300, 520],
              contents: 'Outdated hypothesis',
              color: [1, 0, 0],
            },
            {
              subtype: 'Link',
              rect: [10, 10, 50, 50],
            },
          ]),
        }),
      } as never);

      const imported = await importer.importFromAttachment('user-1', 'att-1');
      expect(imported.totalFound).toBe(2);
      expect(imported.imported).toBe(2);
      expect(
        mockAnnotationsService.batchUpsertAnnotations,
      ).toHaveBeenCalledWith(
        'user-1',
        'att-1',
        expect.objectContaining({
          upserts: expect.arrayContaining([
            expect.objectContaining({
              type: AnnotationType.highlight,
              pageIndex: 0,
              x: 0.1,
              y: 0.25,
              color: '#ffd400',
              rectCoords: [
                {
                  x1: 0.1,
                  y1: 0.25,
                  x2: 0.5,
                  y2: 0.3,
                  width: 0.4,
                  height: 0.05,
                },
              ],
            }),
            expect.objectContaining({
              type: AnnotationType.strike,
              color: '#ff0000',
            }),
          ]),
        }),
        undefined,
      );

      mockAnnotationsService.batchUpsertAnnotations.mockClear();
      mockAnnotationsRepo.findExistingForImport.mockResolvedValueOnce([
        {
          pageIndex: 0,
          type: AnnotationType.highlight,
          rectCoords: [{ x1: 0.1, y1: 0.25 }],
        },
        {
          pageIndex: 0,
          type: AnnotationType.strike,
          rectCoords: [{ x1: 0.1, y1: 0.48 }],
        },
      ]);
      const deduped = await importer.importFromAttachment('user-1', 'att-1');
      expect(deduped.imported).toBe(0);
      expect(
        mockAnnotationsService.batchUpsertAnnotations,
      ).not.toHaveBeenCalled();
    });
  });
});
