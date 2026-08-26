import { MetadataService } from '@/modules/library/metadata/metadata.service';
import { SemanticScholarProvider } from '@/modules/library/metadata/providers/semantic.provider';
import { ArxivProvider } from '@/modules/library/metadata/providers/arxiv.provider';
import { PubmedProvider } from '@/modules/library/metadata/providers/pubmed.provider';
import { OpenlibraryProvider } from '@/modules/library/metadata/providers/openlibrary.provider';
import { OpenAlexProvider } from '@/modules/library/metadata/providers/openalex.provider';
import { UnpaywallProvider } from '@/modules/library/metadata/providers/unpaywall.provider';

import { DoiResolver } from '@/modules/library/cite/resolvers/doi.resolver';
import { BibtexFormatter } from '@/modules/library/cite/formatters/bibtex.formatter';

describe('MetadataService', () => {
  let service: MetadataService;
  let mockS2: jest.Mocked<SemanticScholarProvider>;
  let mockArxiv: jest.Mocked<ArxivProvider>;
  let mockPubmed: jest.Mocked<PubmedProvider>;
  let mockOpenlibrary: jest.Mocked<OpenlibraryProvider>;
  let mockOpenAlex: jest.Mocked<OpenAlexProvider>;
  let mockUnpaywall: jest.Mocked<UnpaywallProvider>;
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

    mockOpenAlex = {
      fetchByDoi: jest.fn(),
      searchByTitle: jest.fn(),
      transformPayload: jest.fn(),
    } as any;

    mockUnpaywall = {
      resolveOaPdf: jest.fn(),
    } as any;

    mockDoi = {
      resolve: jest.fn(),
      cleanDoi: jest.fn((d) => d),
    } as any;

    formatter = new BibtexFormatter();

    service = new MetadataService(
      mockS2,
      mockArxiv,
      mockPubmed,
      mockOpenlibrary,
      mockOpenAlex,
      mockUnpaywall,
      mockDoi,
      formatter,
    );
  });

  it('should resolve arXiv query via SemanticScholar and fallback to direct ArxivProvider', async () => {
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
    expect(result?.metadata.openAccessPdfUrl).toBe(
      'https://arxiv.org/pdf/1706.03762.pdf',
    );
  });

  it('resolves DOI via CrossRef first (authoritative registry) — ADR-0003', async () => {
    // CrossRef is primary for DOI — DoiResolver mock returns the paper
    mockDoi.resolve.mockResolvedValueOnce({
      title: 'Deep Residual Learning for Image Recognition',
      authors: ['He, Kaiming', 'Zhang, Xiangyu'],
      year: 2016,
      doi: '10.1109/CVPR.2016.90',
      itemType: 'conferencePaper',
    });
    // S2 called as enricher for tldr — return supplementary data
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
    // CrossRef is authoritative — provider should be CrossRef, not SemanticScholar
    expect(result?.provider).toBe('CrossRef');
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

    const result = await service.resolve(
      'Language Models are Few-Shot Learners',
    );

    expect(result).toBeDefined();
    expect(result?.queryType).toBe('TITLE');
    expect(result?.metadata.title).toBe(
      'Language Models are Few-Shot Learners',
    );
    expect(result?.metadata.citationKey).toBe('brown2020language');
  });
});
