import { AcademicBundleService } from '@/modules/library/academic-bundle/academic-bundle.service';
import { CslFormatter } from '@/modules/library/citation/formatters/csl.formatter';

describe('AcademicBundleService', () => {
  let service: AcademicBundleService;
  let mockCatalogRepo: any;
  let cslFormatter: CslFormatter;
  let mockAnnotationsService: any;
  let mockKnowledgeService: any;

  beforeEach(() => {
    mockCatalogRepo = {
      resolveWorkspace: jest.fn().mockResolvedValue({ id: 'ws-1' }),
      resolveWorkspaceId: jest.fn().mockResolvedValue('ws-1'),
      findItemById: jest.fn(),
    };

    cslFormatter = new CslFormatter();

    mockAnnotationsService = {
      getAnnotations: jest.fn().mockResolvedValue({
        annotations: [
          {
            id: 'ann-1',
            quote: 'Attention is all you need quote',
            pageNumber: 1,
          },
        ],
        total: 1,
      }),
    };

    mockKnowledgeService = {
      getRelatedPapers: jest.fn().mockResolvedValue({
        relatedPapers: [
          { id: 'paper-bert', title: 'BERT', relationType: 'extends' },
        ],
        total: 1,
      }),
      getrelatedItems: jest.fn().mockResolvedValue({
        relatedItems: [
          { id: 'paper-bert', title: 'BERT', relationType: 'extends' },
        ],
        total: 1,
      }),
    };

    service = new AcademicBundleService(
      mockCatalogRepo,
      cslFormatter,
      mockAnnotationsService,
      mockKnowledgeService,
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

    mockCatalogRepo.findItemById.mockResolvedValue(mockPaper);

    const bundle = await service.getItemAcademicBundle(
      'ws-1',
      'paper-transformer',
    );

    expect(bundle.item.id).toBe('paper-transformer');
    expect(bundle.citationApa.inText).toBe('(Vaswani, 2017)');
    expect(bundle.citationIeee.inText).toBe('[1]');
    expect(bundle.totalAnnotations).toBe(1);
    expect(bundle.annotations[0].quote).toContain(
      'Attention is all you need quote',
    );
    expect(bundle.totalRelatedItems).toBe(1);
    expect(bundle.relatedItems[0].id).toBe('paper-bert');
  });
});
