import { UnifiedFetcherService } from '@/modules/library/reference/fetchers/unified-fetcher.service';
import { SemanticScholarFetcher } from '@/modules/library/reference/fetchers/semantic-scholar.fetcher';
import { ArxivFetcher } from '@/modules/library/reference/fetchers/arxiv.fetcher';
import { PubmedFetcher } from '@/modules/library/reference/fetchers/pubmed.fetcher';
import { OpenlibraryFetcher } from '@/modules/library/reference/fetchers/openlibrary.fetcher';
import { UnpaywallFetcher } from '@/modules/library/reference/fetchers/unpaywall.fetcher';
import { DoiResolver } from '@/modules/library/reference/resolvers/doi.resolver';
import { BibtexFormatter } from '@/modules/library/reference/formatters/bibtex.formatter';

describe('UnifiedFetcherService', () => {
  let service: UnifiedFetcherService;
  let mockS2: jest.Mocked<SemanticScholarFetcher>;
  let mockArxiv: jest.Mocked<ArxivFetcher>;
  let mockPubmed: jest.Mocked<PubmedFetcher>;
  let mockOpenlibrary: jest.Mocked<OpenlibraryFetcher>;
  let mockUnpaywall: jest.Mocked<UnpaywallFetcher>;
  let mockDoi: jest.Mocked<DoiResolver>;
  let formatter: BibtexFormatter;

  beforeEach(() => {
    mockS2 = {
      fetchById: jest.fn(),
      searchByTitle: jest.fn(),
    } as any;

    mockArxiv = {
      fetchById: jest.fn(),
    } as any;

    mockPubmed = {
      fetchByPmid: jest.fn(),
    } as any;

    mockOpenlibrary = {
      fetchByIsbn: jest.fn(),
    } as any;

    mockUnpaywall = {
      resolveOaPdf: jest.fn(),
    } as any;

    mockDoi = {
      resolve: jest.fn(),
      cleanDoi: jest.fn((d) => d),
    } as any;

    formatter = new BibtexFormatter();

    service = new UnifiedFetcherService(
      mockS2,
      mockArxiv,
      mockPubmed,
      mockOpenlibrary,
      mockUnpaywall,
      mockDoi,
      formatter,
    );
  });

  it('should resolve arXiv query via SemanticScholar and fallback to direct ArxivFetcher', async () => {
    mockS2.fetchById.mockResolvedValueOnce(null);
    mockArxiv.fetchById.mockResolvedValueOnce({
      title: 'Attention Is All You Need',
      authors: ['Vaswani, Ashish', 'Shazeer, Noam'],
      year: 2017,
      arxivId: '1706.03762',
      itemType: 'preprint',
      openAccessPdfUrl: 'https://arxiv.org/pdf/1706.03762.pdf',
    });

    const result = await service.resolve('1706.03762');

    expect(result).toBeDefined();
    expect(result?.queryType).toBe('ARXIV');
    expect(result?.provider).toBe('arXiv');
    expect(result?.metadata.title).toBe('Attention Is All You Need');
    expect(result?.metadata.citationKey).toBe('vaswani2017attention');
    expect(result?.metadata.openAccessPdfUrl).toBe('https://arxiv.org/pdf/1706.03762.pdf');
  });

  it('should resolve DOI query via SemanticScholar with rich TLDR', async () => {
    mockS2.fetchById.mockResolvedValueOnce({
      title: 'Deep Residual Learning for Image Recognition',
      authors: ['He, Kaiming', 'Zhang, Xiangyu'],
      year: 2016,
      doi: '10.1109/CVPR.2016.90',
      itemType: 'conferencePaper',
      tldr: 'Presents residual learning framework to ease the training of substantially deeper networks.',
    });

    const result = await service.resolve('10.1109/CVPR.2016.90');

    expect(result).toBeDefined();
    expect(result?.queryType).toBe('DOI');
    expect(result?.provider).toBe('SemanticScholar');
    expect(result?.metadata.tldr).toBeDefined();
    expect(result?.metadata.citationKey).toBe('he2016deep');
  });

  it('should fallback to CrossRef when SemanticScholar returns null for DOI', async () => {
    mockS2.fetchById.mockResolvedValueOnce(null);
    mockDoi.resolve.mockResolvedValueOnce({
      title: 'Structure of the Atom',
      authors: ['Bohr, Niels'],
      year: 1913,
      doi: '10.1080/14786441308634955',
      itemType: 'journalArticle',
      journal: 'Philosophical Magazine',
    });

    const result = await service.resolve('10.1080/14786441308634955');

    expect(result).toBeDefined();
    expect(result?.provider).toBe('CrossRef');
    expect(result?.metadata.title).toBe('Structure of the Atom');
    expect(result?.metadata.citationKey).toBe('bohr1913structure');
  });

  it('should resolve title query via SemanticScholar title search', async () => {
    mockS2.searchByTitle.mockResolvedValueOnce({
      title: 'Language Models are Few-Shot Learners',
      authors: ['Brown, Tom B.'],
      year: 2020,
      itemType: 'preprint',
    });

    const result = await service.resolve('Language Models are Few-Shot Learners');

    expect(result).toBeDefined();
    expect(result?.queryType).toBe('TITLE');
    expect(result?.metadata.title).toBe('Language Models are Few-Shot Learners');
    expect(result?.metadata.citationKey).toBe('brown2020language');
  });
});
