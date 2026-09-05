import { ExecutionContext, CallHandler } from '@nestjs/common';
import { of } from 'rxjs';
import { TransformInterceptor } from '../../../src/core/interceptors/transform.interceptor';
import { CatalogController } from '../../../src/modules/library/items/items.controller';
import { CollectionsController } from '../../../src/modules/library/collections/collections.controller';
import { NotesController } from '../../../src/modules/library/notes/notes.controller';
import { AttachmentsController } from '../../../src/modules/library/attachments/attachments.controller';
import { AnnotationsController } from '../../../src/modules/library/annotations/annotations.controller';
import { ReadingController } from '../../../src/modules/library/reading/reading.controller';
import { SearchController } from '../../../src/modules/library/search/search.controller';
import { CitationController } from '../../../src/modules/library/citation/citation.controller';
import { ExportsController } from '../../../src/modules/library/exports/exports.controller';
import { IngestionController } from '../../../src/modules/library/ingestion/ingestion.controller';
import { SyncController } from '../../../src/modules/library/sync/sync.controller';

describe('Library Canonical API Contracts (T048)', () => {
  let interceptor: TransformInterceptor<any>;

  beforeEach(() => {
    interceptor = new TransformInterceptor();
  });

  const runThroughInterceptor = async (data: any) => {
    const mockContext: ExecutionContext = {
      switchToHttp: () => ({
        getResponse: () => ({}),
        getRequest: () => ({}),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as any;

    const mockCallHandler: CallHandler = {
      handle: () => of(data),
    };

    return interceptor.intercept(mockContext, mockCallHandler).toPromise();
  };

  describe('TransformInterceptor Canonical Envelope Compliance', () => {
    it('should wrap domain entity in canonical success envelope', async () => {
      const rawEntity = { id: 'item-1', title: 'Attention Is All You Need' };
      const enveloped = await runThroughInterceptor(rawEntity);

      expect(enveloped).toEqual({
        success: true,
        data: rawEntity,
        timestamp: expect.any(String),
      });
    });

    it('should transform standard paginated result ({ items, pagination }) into canonical envelope', async () => {
      const paginatedResult = {
        items: [{ id: 'item-1' }, { id: 'item-2' }],
        pagination: {
          cursor: 'cur-123',
          hasNextPage: true,
          totalCount: 50,
        },
      };

      const enveloped = await runThroughInterceptor(paginatedResult);

      expect(enveloped).toEqual({
        success: true,
        data: paginatedResult.items,
        pagination: paginatedResult.pagination,
        timestamp: expect.any(String),
      });
    });
  });

  describe('Controller Execution without Manual Double Envelopes', () => {
    it('CatalogController.listItems should return raw items and pagination metadata', async () => {
      const mockCatalogService: any = {
        listItems: jest.fn().mockResolvedValue({
          items: [{ id: 'item-1', title: 'Test Paper' }],
          meta: { hasNextPage: false, totalCount: 1 },
        }),
      };
      const controller = new CatalogController(mockCatalogService, {} as any);
      const result = await controller.listItems('ws-1', 'ws-1', 'usr-1', {});

      expect(result).toEqual({
        items: [{ id: 'item-1', title: 'Test Paper' }],
        pagination: { hasNextPage: false, totalCount: 1 },
      });
      // Should NOT have manual success envelope
      expect((result as any).success).toBeUndefined();

      const transformed = await runThroughInterceptor(result);
      expect(transformed.success).toBe(true);
      expect(transformed.data).toEqual([{ id: 'item-1', title: 'Test Paper' }]);
      expect(transformed.pagination).toEqual({
        hasNextPage: false,
        totalCount: 1,
      });
    });

    it('CatalogController.getItem should return domain entity directly', async () => {
      const mockItem = { id: 'item-1', title: 'Test Paper', version: 1 };
      const mockCatalogService: any = {
        getItem: jest.fn().mockResolvedValue(mockItem),
      };
      const controller = new CatalogController(mockCatalogService, {} as any);
      const result = await controller.getItem(
        'ws-1',
        'ws-1',
        'item-1',
        'usr-1',
      );

      expect(result).toBe(mockItem);
      expect((result as any).success).toBeUndefined();

      const transformed = await runThroughInterceptor(result);
      expect(transformed.success).toBe(true);
      expect(transformed.data).toEqual(mockItem);
    });

    it('NotesController.listNotes should return notes array directly', async () => {
      const mockNotes = [{ id: 'note-1', title: 'Summary' }];
      const mockNotesService: any = {
        listNotes: jest.fn().mockResolvedValue(mockNotes),
      };
      const controller = new NotesController(mockNotesService);
      const result = await controller.listNotes('ws-1', 'item-1');

      expect(result).toBe(mockNotes);
      expect((result as any).success).toBeUndefined();

      const transformed = await runThroughInterceptor(result);
      expect(transformed.success).toBe(true);
      expect(transformed.data).toEqual(mockNotes);
    });

    it('AnnotationsController.listAnnotations should return annotations array directly', async () => {
      const mockAnnotations = [{ id: 'anno-1', color: '#ff0000' }];
      const mockService: any = {
        getAnnotationsByAttachment: jest
          .fn()
          .mockResolvedValue(mockAnnotations),
      };
      const controller = new AnnotationsController(mockService);
      const result = await controller.listAnnotations('ws-1', 'att-1', '0');

      expect(result).toBe(mockAnnotations);
      expect((result as any).success).toBeUndefined();

      const transformed = await runThroughInterceptor(result);
      expect(transformed.success).toBe(true);
      expect(transformed.data).toEqual(mockAnnotations);
    });

    it('ReadingController.getState should return state directly', async () => {
      const mockState = { readStatus: 'reading', rating: 4 };
      const mockService: any = {
        getState: jest.fn().mockResolvedValue(mockState),
      };
      const controller = new ReadingController(mockService);
      const result = await controller.getState('ws-1', 'item-1', 'usr-1');

      expect(result).toBe(mockState);
      expect((result as any).success).toBeUndefined();

      const transformed = await runThroughInterceptor(result);
      expect(transformed.success).toBe(true);
      expect(transformed.data).toEqual(mockState);
    });

    it('CitationController.format should return formatted citation directly', async () => {
      const mockCitation = { text: 'Vaswani et al. (2017)' };
      const mockService: any = {
        formatItem: jest.fn().mockReturnValue(mockCitation),
      };
      const controller = new CitationController(mockService);
      const result = controller.format({ item: {} as any, styleId: 'apa-7th' });

      expect(result).toBe(mockCitation);
      expect((result as any).success).toBeUndefined();

      const transformed = await runThroughInterceptor(result);
      expect(transformed.success).toBe(true);
      expect(transformed.data).toEqual(mockCitation);
    });

    it('IngestionController.getStatus should return run status directly', async () => {
      const mockStatus = { runId: 'run-1', status: 'COMPLETED' };
      const mockService: any = {
        getRunStatus: jest.fn().mockResolvedValue(mockStatus),
      };
      const controller = new IngestionController({} as any, mockService);
      const result = await controller.getStatus('ws-1', 'ws-1', 'run-1');

      expect(result).toBe(mockStatus);
      expect((result as any).success).toBeUndefined();

      const transformed = await runThroughInterceptor(result);
      expect(transformed.success).toBe(true);
      expect(transformed.data).toEqual(mockStatus);
    });

    it('SyncController.pullDelta should return delta payload directly', async () => {
      const mockDelta = {
        changes: [],
        tombstones: [],
        latestSeq: '10',
        hasMore: false,
      };
      const mockService: any = {
        pullDelta: jest.fn().mockResolvedValue(mockDelta),
      };
      const controller = new SyncController(mockService);
      const result = await controller.pullDelta('ws-1', '0', '100');

      expect(result).toBe(mockDelta);
      expect((result as any).success).toBeUndefined();

      const transformed = await runThroughInterceptor(result);
      expect(transformed.success).toBe(true);
      expect(transformed.data).toEqual(mockDelta);
    });
  });

  describe('Optimistic Concurrency Guards', () => {
    it('CatalogController.updateItem should reject update without expectedVersion or If-Match', async () => {
      const controller = new CatalogController({} as any, {} as any);
      await expect(
        controller.updateItem('ws-1', 'ws-1', 'item-1', undefined, {
          title: 'New Title',
        }),
      ).rejects.toThrow('Optimistic locking requirement');
    });

    it('NotesController.updateNote should reject update without expectedVersion or If-Match', async () => {
      const controller = new NotesController({} as any);
      await expect(
        controller.updateNote('ws-1', 'note-1', undefined, {
          title: 'New Title',
        }),
      ).rejects.toThrow('Optimistic locking requirement');
    });

    it('AnnotationsController.updateAnnotation should reject update without expectedVersion or If-Match', async () => {
      const controller = new AnnotationsController({} as any);
      await expect(
        controller.updateAnnotation('ws-1', 'anno-1', undefined, {
          comment: 'Updated',
        }),
      ).rejects.toThrow('Optimistic locking requirement');
    });
  });
});
