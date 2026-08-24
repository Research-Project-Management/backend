import { AnnotationService } from '@/modules/library/annotation/annotation.service';
import { PaperRepository } from '@/modules/library/paper/paper.repository';

describe('Seam 2A: AnnotationService (Atomic PDF Annotations & Zotero 7 Synthesis)', () => {
  let service: AnnotationService;
  let mockPaperRepo: any;

  const mockPaperWithRelations = {
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
          quote: 'The dominant sequence transduction models are based on complex RNNs...',
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
          quote: 'An attention function can be described as mapping a query and a set of key-value pairs...',
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
    mockPaperRepo = {
      resolveWorkspace: jest.fn().mockResolvedValue({ id: 'ws-1' }),
      findPaperById: jest.fn(),
      updatePaper: jest.fn(),
      mutatePaperExtra: jest.fn().mockImplementation(async (paperId, mutator) => {
        const extraObj = mockPaperWithRelations.extra
          ? JSON.parse(mockPaperWithRelations.extra)
          : {};
        const updated = await mutator(extraObj);
        return {
          paper: { ...mockPaperWithRelations, extra: JSON.stringify(updated) },
          extraObj: updated,
        };
      }),
    };

    service = new AnnotationService(mockPaperRepo);
  });

  describe('Vertical Slice 2.1: Concurrency Isolation & Creation', () => {
    it('should retrieve all annotations for a paper', async () => {
      mockPaperRepo.findPaperById.mockResolvedValue(mockPaperWithRelations);

      const res = await service.getAnnotations('ws-1', 'paper-1');

      expect(res.total).toBe(2);
      expect(res.annotations[0].quote).toContain('dominant sequence');
      expect(res.annotations[1].pageNumber).toBe(3);
    });

    it('should create an annotation and preserve pre-existing relations in paper.extra', async () => {
      mockPaperRepo.findPaperById.mockResolvedValue(mockPaperWithRelations);

      let capturedExtraObj: any = null;
      mockPaperRepo.mutatePaperExtra.mockImplementationOnce(async (paperId: string, mutator: any) => {
        const extraObj = JSON.parse(mockPaperWithRelations.extra);
        capturedExtraObj = await mutator(extraObj);
        return { paper: mockPaperWithRelations, extraObj: capturedExtraObj };
      });

      const res = await service.createAnnotation('ws-1', 'paper-1', 'u-1', {
        type: 'highlight',
        pageNumber: 5,
        color: '#2196F3',
        quote: 'Multi-Head Attention allows the model to jointly attend...',
      });

      expect(res.annotation.id).toBeDefined();
      expect(res.annotation.pageNumber).toBe(5);
      expect(capturedExtraObj.relations).toHaveLength(1);
      expect(capturedExtraObj.relations[0].type).toBe('cites');
      expect(capturedExtraObj.annotations).toHaveLength(3);
    });
  });

  describe('Vertical Slice 2.2: Annotation Update and Deletion', () => {
    it('should update annotation comment and color while updating timestamp', async () => {
      mockPaperRepo.findPaperById.mockResolvedValue(mockPaperWithRelations);

      const res = await service.updateAnnotation('ws-1', 'paper-1', 'ann-1', {
        comment: 'Updated critical insight',
        color: '#E91E63',
      });

      expect(res.annotation.comment).toBe('Updated critical insight');
      expect(res.annotation.color).toBe('#E91E63');
      expect(mockPaperRepo.mutatePaperExtra).toHaveBeenCalled();
    });

    it('should delete specified annotation and return accurate remaining count', async () => {
      mockPaperRepo.findPaperById.mockResolvedValue(mockPaperWithRelations);

      const res = await service.deleteAnnotation('ws-1', 'paper-1', 'ann-1');

      expect(res.deleted).toBe(true);
      expect(res.remainingCount).toBe(1);
    });
  });

  describe('Vertical Slice 2.3: Zotero 7 Literature Note Synthesis', () => {
    it('should extract annotations into a synthesized Markdown Literature Note sorted by page', async () => {
      mockPaperRepo.findPaperById.mockResolvedValue(mockPaperWithRelations);
      mockPaperRepo.updatePaper.mockResolvedValue({});

      const res = await service.extractNotesFromAnnotations('ws-1', 'paper-1', 'u-1');

      expect(res.literatureNote.annotationCount).toBe(2);
      expect(res.literatureNote.content).toContain('# 📖 Literature Notes: Attention Is All You Need');
      expect(res.literatureNote.content).toContain('### 📄 Page 1');
      expect(res.literatureNote.content).toContain('> "The dominant sequence');
      expect(res.literatureNote.content).toContain('*(p. 1)*');
      expect(res.literatureNote.content).toContain('**Note**: Key motivation of Transformer');
      expect(res.literatureNote.content).toContain('### 📄 Page 3');

      expect(mockPaperRepo.updatePaper).toHaveBeenCalledWith(
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
