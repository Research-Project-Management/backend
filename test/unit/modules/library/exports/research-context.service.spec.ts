import { ContextService as ResearchContextService } from '@/modules/library/context/context.service';

import { CslFormatter } from '@/modules/library/cite/formatters/csl.formatter';

describe('ResearchContextService', () => {
  let service: ResearchContextService;
  let mockCatalogRepo: any;
  let mockExtraStore: any;
  let cslFormatter: CslFormatter;
  let mockRelationGraphService: any;

  beforeEach(() => {
    mockCatalogRepo = {
      resolveWorkspace: jest.fn().mockResolvedValue({ id: 'ws-1' }),
      resolveWorkspaceId: jest.fn().mockResolvedValue('ws-1'),
      findItemById: jest.fn(),
      getAnnotations: jest.fn().mockResolvedValue([
        {
          id: 'ann-1',
          quote: 'Attention is all you need quote',
          pageNumber: 1,
        },
      ]),
    };

    cslFormatter = new CslFormatter();

    mockRelationGraphService = {
      getRelatedItems: jest.fn().mockResolvedValue({
        relatedItems: [
          { id: 'paper-bert', title: 'BERT', relationType: 'extends' },
        ],
        total: 1,
      }),
    };

    service = new ResearchContextService(
      mockCatalogRepo,
      cslFormatter,
      mockRelationGraphService,
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

    const bundle = await service.getItemResearchContext(
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
