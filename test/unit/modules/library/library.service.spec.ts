import { LibraryService } from '@/modules/library/library.service';
import { PaperRepository } from '@/modules/library/paper/paper.repository';
import { CslFormatter } from '@/modules/library/reference/formatters/csl.formatter';
import { AnnotationService } from '@/modules/library/annotation/annotation.service';
import { RelationService } from '@/modules/library/relation/relation.service';

describe('LibraryService (Unified Academic Facade)', () => {
  let service: LibraryService;
  let mockPaperRepo: any;
  let cslFormatter: CslFormatter;
  let mockAnnotationService: any;
  let mockRelationService: any;

  beforeEach(() => {
    mockPaperRepo = {
      resolveWorkspace: jest.fn().mockResolvedValue({ id: 'ws-1' }),
      findPaperById: jest.fn(),
    };

    cslFormatter = new CslFormatter();

    mockAnnotationService = {
      getAnnotations: jest.fn().mockResolvedValue({
        annotations: [
          { id: 'ann-1', quote: 'Attention is all you need quote', pageNumber: 1 },
        ],
        total: 1,
      }),
    };

    mockRelationService = {
      getRelatedPapers: jest.fn().mockResolvedValue({
        relatedPapers: [
          { id: 'paper-bert', title: 'BERT', relationType: 'extends' },
        ],
        total: 1,
      }),
    };

    service = new LibraryService(
      mockPaperRepo,
      cslFormatter,
      mockAnnotationService,
      mockRelationService,
    );
  });

  it('should retrieve a unified academic bundle in a single call', async () => {
    const mockPaper = {
      id: 'paper-transformer',
      workspaceId: 'ws-1',
      title: 'Attention Is All You Need',
      authors: ['Vaswani, Ashish'],
      year: 2017,
      deletedAt: null,
    };

    mockPaperRepo.findPaperById.mockResolvedValue(mockPaper);

    const bundle = await service.getPaperAcademicBundle('ws-1', 'paper-transformer');

    expect(bundle.paper.id).toBe('paper-transformer');
    expect(bundle.citationApa.inText).toBe('(Vaswani, 2017)');
    expect(bundle.citationIeee.inText).toBe('[1]');
    expect(bundle.totalAnnotations).toBe(1);
    expect(bundle.annotations[0].quote).toContain('Attention is all you need quote');
    expect(bundle.totalRelatedPapers).toBe(1);
    expect(bundle.relatedPapers[0].id).toBe('paper-bert');
  });
});
