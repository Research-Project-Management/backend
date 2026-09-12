import { ExportsService } from '../../src/modules/library/exports/exports.service';
import { CitationService } from '../../src/modules/library/citation/citation.service';

describe('ExportsService - exportByCitationKeys', () => {
  let service: ExportsService;
  let mockPrisma: any;
  let mockCitationService: any;

  beforeEach(() => {
    mockPrisma = {
      tenantWorkspace: {
        findUnique: jest.fn().mockResolvedValue({ id: 'resolved-ws-uuid' }),
        findFirst: jest.fn().mockResolvedValue({ id: 'resolved-ws-uuid' }),
      },
      item: {
        findMany: jest.fn(),
      },
    };

    mockCitationService = {
      formatItem: jest.fn().mockImplementation((item) => ({
        bibliography: `@article{${item.citationKey},\n  title = {${item.title}},\n  year = {${item.year}}\n}`,
      })),
    };

    service = new ExportsService(
      mockPrisma,
      mockCitationService as CitationService,
    );
  });

  it('returns empty result when keys array is empty', async () => {
    const res = await service.exportByCitationKeys('resolved-ws-uuid', []);
    expect(res).toEqual({
      content: '',
      count: 0,
      foundKeys: [],
      missingKeys: [],
    });
    expect(mockPrisma.item.findMany).not.toHaveBeenCalled();
  });

  it('fetches items, formats BibTeX, and separates found from missing keys', async () => {
    mockPrisma.item.findMany.mockResolvedValue([
      {
        id: 'item-1',
        citationKey: 'vaswani2017attention',
        title: 'Attention Is All You Need',
        year: 2017,
        itemType: 'journalArticle',
        contributors: [
          { firstName: 'Ashish', lastName: 'Vaswani', orderIndex: 0 },
        ],
      },
      {
        id: 'item-2',
        citationKey: 'devlin2018bert',
        title: 'BERT',
        year: 2018,
        itemType: 'journalArticle',
        contributors: [
          { firstName: 'Jacob', lastName: 'Devlin', orderIndex: 0 },
        ],
      },
    ]);

    const res = await service.exportByCitationKeys('resolved-ws-uuid', [
      'Vaswani2017Attention',
      'unknownKey2024',
    ]);

    expect(res.count).toBe(1);
    expect(res.foundKeys).toContain('vaswani2017attention');
    expect(res.missingKeys).toContain('unknownKey2024');
    expect(res.content).toContain('@article{vaswani2017attention');
    expect(mockCitationService.formatItem).toHaveBeenCalledTimes(1);
  });
});
