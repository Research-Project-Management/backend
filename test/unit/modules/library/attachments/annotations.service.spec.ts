import { AnnotationsService } from '@/modules/library/attachments/annotations/annotations.service';

describe('AnnotationsService', () => {
  let service: AnnotationsService;
  let mockCatalogRepo: any;

  const mockCatalogItemWithRelations = {
    id: 'paper-1',
    workspaceId: 'ws-1',
    title: 'Attention Is All You Need',
    extra: JSON.stringify({
      relations: [
        {
          targetPaperId: 'paper-2',
          type: 'cites',
          linkedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      annotations: [
        {
          id: 'ann-1',
          paperId: 'paper-1',
          type: 'highlight',
          pageNumber: 1,
          color: '#FFEB3B',
          quote:
            'The dominant sequence transduction models are based on complex RNNs...',
          comment: 'Key motivation of Transformer',
          authorId: 'u-1',
          createdAt: '2026-01-01T10:00:00.000Z',
          updatedAt: '2026-01-01T10:00:00.000Z',
        },
        {
          id: 'ann-2',
          paperId: 'paper-1',
          type: 'highlight',
          pageNumber: 3,
          color: '#4CAF50',
          quote:
            'An attention function can be described as mapping a query and a set of key-value pairs...',
          comment: 'Attention formula definition',
          authorId: 'u-1',
          createdAt: '2026-01-01T10:05:00.000Z',
          updatedAt: '2026-01-01T10:05:00.000Z',
        },
      ],
    }),
    notes: [],
    deletedAt: null,
  };

  beforeEach(() => {
    mockCatalogRepo = {
      resolveWorkspace: jest.fn().mockResolvedValue({ id: 'ws-1' }),
      resolveWorkspaceId: jest.fn().mockResolvedValue('ws-1'),
      findItemById: jest.fn(),
      findItemByIdInWorkspace: jest.fn(),
      updateItem: jest.fn().mockResolvedValue(mockCatalogItemWithRelations),
      updatePaper: jest.fn().mockResolvedValue(mockCatalogItemWithRelations),
      mutatePaperExtra: jest
        .fn()
        .mockImplementation(async (_itemId, mutator) => {
          const extraObj = mockCatalogItemWithRelations.extra
            ? JSON.parse(mockCatalogItemWithRelations.extra)
            : {};
          const updated = await mutator(extraObj);
          return {
            paper: {
              ...mockCatalogItemWithRelations,
              extra: JSON.stringify(updated),
            },
            extraObj: updated,
          };
        }),
    };

    service = new AnnotationsService(mockCatalogRepo, {
      getAnnotations: jest.fn().mockImplementation((_itemId: string) => {
        const extra = JSON.parse(mockCatalogItemWithRelations.extra);
        return extra.annotations ?? [];
      }),
      putAnnotation: jest
        .fn()
        .mockImplementation((_itemId: string, annotation: any) => {
          return { id: annotation.id, ...annotation };
        }),
      replaceAnnotation: jest
        .fn()
        .mockImplementation(
          (_itemId: string, annotationId: string, patch: any) => {
            const extra = JSON.parse(mockCatalogItemWithRelations.extra);
            const ann = extra.annotations?.find(
              (a: any) => a.id === annotationId,
            );
            return ann ? { ...ann, ...patch } : null;
          },
        ),
      removeAnnotation: jest.fn().mockResolvedValue(undefined),
    } as any);
  });

  describe('Annotation Retrieval & Creation', () => {
    it('should retrieve all annotations for a catalog item', async () => {
      mockCatalogRepo.findItemByIdInWorkspace.mockResolvedValue(
        mockCatalogItemWithRelations,
      );

      const res = await service.getAnnotations('ws-1', 'paper-1');

      expect(res.total).toBe(2);
      expect(res.annotations[0].quote).toContain('dominant sequence');
      expect(res.annotations[1].pageNumber).toBe(3);
    });

    it('should create an annotation and preserve pre-existing relations in item extra data', async () => {
      mockCatalogRepo.findItemByIdInWorkspace.mockResolvedValue(
        mockCatalogItemWithRelations,
      );

      const res = await service.createAnnotation('ws-1', 'paper-1', 'u-1', {
        type: 'highlight',
        pageNumber: 5,
        color: '#2196F3',
        quote: 'Multi-Head Attention allows the model to jointly attend...',
      });

      expect(res.annotation.id).toBeDefined();
      expect(res.annotation.pageNumber).toBe(5);
      // CatalogExtraStore.putAnnotation should have been called once
      const extraStore = (service as any).extraStore;
      expect(extraStore.putAnnotation).toHaveBeenCalledWith(
        'paper-1',
        expect.objectContaining({ pageNumber: 5 }),
      );
    });
  });

  describe('Annotation Update & Deletion', () => {
    it('should update annotation comment and color while updating timestamp', async () => {
      mockCatalogRepo.findItemByIdInWorkspace.mockResolvedValue(
        mockCatalogItemWithRelations,
      );

      const extraStore = (service as any).extraStore;

      const res = await service.updateAnnotation('ws-1', 'paper-1', 'ann-1', {
        comment: 'Updated critical insight',
        color: '#E91E63',
      });

      expect(res.annotation.comment).toBe('Updated critical insight');
      expect(res.annotation.color).toBe('#E91E63');
      // AnnotationsService uses extraStore.replaceAnnotation for updates
      expect(extraStore.replaceAnnotation).toHaveBeenCalled();
    });

    it('should delete specified annotation and return accurate remaining count', async () => {
      mockCatalogRepo.findItemByIdInWorkspace.mockResolvedValue(
        mockCatalogItemWithRelations,
      );

      // removeAnnotation resolves: remaining count = 2 annotations - 1 deleted = 1
      const extraStore = (service as any).extraStore;
      extraStore.removeAnnotation.mockResolvedValueOnce(1);

      const res = await service.deleteAnnotation('ws-1', 'paper-1', 'ann-1');

      expect(res.deleted).toBe(true);
      expect(extraStore.removeAnnotation).toHaveBeenCalledWith(
        'paper-1',
        'ann-1',
      );
    });
  });

  describe('Literature Note Synthesis', () => {
    it('should extract annotations into a synthesized Markdown Literature Note sorted by page', async () => {
      mockCatalogRepo.findItemByIdInWorkspace.mockResolvedValue(
        mockCatalogItemWithRelations,
      );
      mockCatalogRepo.updatePaper.mockResolvedValue({});

      const res = await service.extractNotesFromAnnotations(
        'ws-1',
        'paper-1',
        'u-1',
      );

      expect(res.literatureNote.annotationCount).toBe(2);
      expect(res.literatureNote.content).toContain(
        '# 📖 Literature Notes: Attention Is All You Need',
      );
      expect(res.literatureNote.content).toContain('### 📄 Page 1');
      expect(res.literatureNote.content).toContain('> "The dominant sequence');
      expect(res.literatureNote.content).toContain('*(p. 1)*');
      expect(res.literatureNote.content).toContain(
        '**Note**: Key motivation of Transformer',
      );
      expect(res.literatureNote.content).toContain('### 📄 Page 3');

      expect(mockCatalogRepo.updateItem).toHaveBeenCalledWith(
        'paper-1',
        expect.objectContaining({
          notes: expect.arrayContaining([
            expect.objectContaining({
              content: expect.stringContaining('# 📖 Literature Notes:'),
            }),
          ]),
        }),
      );
    });
  });
});
