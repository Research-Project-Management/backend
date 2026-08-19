import { AnnotationService } from '@/modules/library/annotation/annotation.service';
import { PaperRepository } from '@/modules/library/paper/paper.repository';

describe('AnnotationService', () => {
  let service: AnnotationService;
  let mockPaperRepo: any;

  beforeEach(() => {
    mockPaperRepo = {
      resolveWorkspace: jest.fn().mockResolvedValue({ id: 'ws-1' }),
      findPaperById: jest.fn(),
      updatePaper: jest.fn(),
    };

    service = new AnnotationService(mockPaperRepo);
  });

  const mockPaper = {
    id: 'paper-1',
    workspaceId: 'ws-1',
    title: 'Attention Is All You Need',
    extra: JSON.stringify({
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
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
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
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    }),
    notes: [],
    deletedAt: null,
  };

  it('should retrieve all annotations for a paper', async () => {
    mockPaperRepo.findPaperById.mockResolvedValue(mockPaper);

    const res = await service.getAnnotations('ws-1', 'paper-1');

    expect(res.total).toBe(2);
    expect(res.annotations[0].quote).toContain('dominant sequence');
    expect(res.annotations[1].pageNumber).toBe(3);
  });

  it('should create a new annotation and persist to paper.extra', async () => {
    mockPaperRepo.findPaperById.mockResolvedValue(mockPaper);
    mockPaperRepo.updatePaper.mockResolvedValue({});

    const res = await service.createAnnotation('ws-1', 'paper-1', 'u-1', {
      type: 'highlight',
      pageNumber: 5,
      color: '#2196F3',
      quote: 'Scaled Dot-Product Attention compute equation 1',
    });

    expect(res.annotation.id).toBeDefined();
    expect(res.annotation.pageNumber).toBe(5);
    expect(mockPaperRepo.updatePaper).toHaveBeenCalledWith(
      'paper-1',
      expect.objectContaining({
        extra: expect.stringContaining('Scaled Dot-Product'),
      }),
    );
  });

  it('should extract annotations into a synthesized Markdown Literature Note', async () => {
    mockPaperRepo.findPaperById.mockResolvedValue(mockPaper);
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
