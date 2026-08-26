import {
  normalizeDoi,
  normalizeArxivId,
  normalizePmid,
  normalizePmcid,
  normalizeIsbn,
  normalizeIssn,
  formatCanonicalId,
  validateAcademicMetadata,
} from '@/modules/library/metadata/utils/metadata.util';
import { OpenAlexProvider } from '@/modules/library/metadata/providers/openalex.provider';
import { ArxivProvider } from '@/modules/library/metadata/providers/arxiv.provider';
import { PubmedProvider } from '@/modules/library/metadata/providers/pubmed.provider';
import { OpenlibraryProvider } from '@/modules/library/metadata/providers/openlibrary.provider';
import { SemanticScholarProvider } from '@/modules/library/metadata/providers/semantic.provider';
import { UnpaywallProvider } from '@/modules/library/metadata/providers/unpaywall.provider';
import { DoiResolver } from '@/modules/library/cite/resolvers/doi.resolver';

describe('Canonical Identifier Utilities', () => {
  describe('normalizeDoi', () => {
    it('normalizes DOI with https://doi.org/ prefix', () => {
      expect(normalizeDoi('https://doi.org/10.1038/nature12345')).toBe(
        '10.1038/nature12345',
      );
    });

    it('normalizes DOI with dx.doi.org and doi: prefix', () => {
      expect(normalizeDoi('http://dx.doi.org/10.1145/3318464.3389700')).toBe(
        '10.1145/3318464.3389700',
      );
      expect(normalizeDoi('doi: 10.1016/j.cell.2020.01.001')).toBe(
        '10.1016/j.cell.2020.01.001',
      );
    });

    it('normalizes prefix and trims surrounding whitespace', () => {
      expect(normalizeDoi('  10.1073/pnas.1912345678  ')).toBe(
        '10.1073/pnas.1912345678',
      );
    });

    it('returns undefined for invalid inputs', () => {
      expect(normalizeDoi(null)).toBeUndefined();
      expect(normalizeDoi('')).toBeUndefined();
      expect(normalizeDoi('not-a-doi')).toBeUndefined();
    });
  });

  describe('normalizeArxivId', () => {
    it('normalizes new style arXiv ID with prefix and URL', () => {
      expect(normalizeArxivId('arXiv:1706.03762')).toBe('1706.03762');
      expect(normalizeArxivId('https://arxiv.org/abs/1706.03762v5')).toBe(
        '1706.03762v5',
      );
      expect(normalizeArxivId('https://arxiv.org/pdf/1706.03762.pdf')).toBe(
        '1706.03762',
      );
    });

    it('strips version when requested', () => {
      expect(normalizeArxivId('1706.03762v7', { stripVersion: true })).toBe(
        '1706.03762',
      );
    });

    it('normalizes legacy arXiv ID', () => {
      expect(normalizeArxivId('arxiv:quant-ph/0201001')).toBe(
        'quant-ph/0201001',
      );
    });

    it('returns undefined for invalid inputs', () => {
      expect(normalizeArxivId(null)).toBeUndefined();
      expect(normalizeArxivId('')).toBeUndefined();
    });
  });

  describe('normalizePmid and normalizePmcid', () => {
    it('normalizes PMID from digits, prefix, and URL', () => {
      expect(normalizePmid('29124373')).toBe('29124373');
      expect(normalizePmid('pmid: 29124373')).toBe('29124373');
      expect(normalizePmid('https://pubmed.ncbi.nlm.nih.gov/29124373/')).toBe(
        '29124373',
      );
    });

    it('normalizes PMCID to uppercase PMC prefix with digits', () => {
      expect(normalizePmcid('PMC5780210')).toBe('PMC5780210');
      expect(normalizePmcid('pmc: 5780210')).toBe('PMC5780210');
      expect(normalizePmcid('5780210')).toBe('PMC5780210');
      expect(
        normalizePmcid('https://www.ncbi.nlm.nih.gov/pmc/articles/PMC5780210/'),
      ).toBe('PMC5780210');
    });
  });

  describe('normalizeIsbn and normalizeIssn', () => {
    it('normalizes ISBN-10 and ISBN-13', () => {
      expect(normalizeIsbn('978-0-262-03384-8')).toBe('9780262033848');
      expect(normalizeIsbn('ISBN: 0-262-03384-4')).toBe('0262033844');
      expect(normalizeIsbn('0-19-852663-X')).toBe('019852663X');
    });

    it('normalizes ISSN to XXXX-XXXX format', () => {
      expect(normalizeIssn('00280836')).toBe('0028-0836');
      expect(normalizeIssn('issn: 0028-0836')).toBe('0028-0836');
      expect(normalizeIssn('1234567X')).toBe('1234-567X');
    });
  });

  describe('formatCanonicalId', () => {
    it('formats canonical URI representation with correct scheme', () => {
      expect(
        formatCanonicalId('doi', 'https://doi.org/10.1038/nature12345'),
      ).toBe('doi:10.1038/nature12345');
      expect(formatCanonicalId('arxiv', 'arxiv:1706.03762v1')).toBe(
        'arxiv:1706.03762v1',
      );
      expect(formatCanonicalId('pmid', 'pmid: 29124373')).toBe('pmid:29124373');
      expect(formatCanonicalId('pmcid', '5780210')).toBe('pmcid:PMC5780210');
      expect(formatCanonicalId('isbn', '978-0-262-03384-8')).toBe(
        'isbn:9780262033848',
      );
      expect(formatCanonicalId('issn', '00280836')).toBe('issn:0028-0836');
    });
  });
});

describe('Academic Metadata Validation', () => {
  it('validates, normalizes, and builds provenance for valid academic payload', () => {
    const raw = {
      title: '  Attention Is All You Need  ',
      authors: ['Ashish Vaswani', 'Noam Shazeer', '', 'Niki Parmar'],
      year: '2017',
      doi: 'https://doi.org/10.5555/3295222.3295349',
      arxivId: 'arxiv:1706.03762',
      keywords: ['Deep Learning', 'Transformers', 'Deep Learning'],
      provenance: {
        originProvider: 'arXiv',
        canonicalId: 'arxiv:1706.03762',
      },
    };

    const validated = validateAcademicMetadata(raw);
    expect(validated).not.toBeNull();
    expect(validated?.title).toBe('Attention Is All You Need');
    expect(validated?.authors).toEqual([
      'Ashish Vaswani',
      'Noam Shazeer',
      'Niki Parmar',
    ]);
    expect(validated?.year).toBe(2017);
    expect(validated?.doi).toBe('10.5555/3295222.3295349');
    expect(validated?.arxivId).toBe('1706.03762');
    expect(validated?.keywords).toEqual(['Deep Learning', 'Transformers']);
    expect(validated?.provenance?.originProvider).toBe('arXiv');
  });

  it('rejects empty or invalid inputs', () => {
    expect(validateAcademicMetadata(null)).toBeNull();
    expect(validateAcademicMetadata([])).toBeNull();
    expect(validateAcademicMetadata({ title: '' })).toBeNull();
  });
});

describe('Academic Metadata Providers', () => {
  let originalFetch: typeof global.fetch;

  beforeAll(() => {
    originalFetch = global.fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  describe('OpenAlexProvider', () => {
    let provider: OpenAlexProvider;

    beforeEach(() => {
      provider = new OpenAlexProvider();
    });

    it('transforms OpenAlex payload and assigns originProvider as OpenAlex (fixing previous OpenLibrary bug)', () => {
      const mockData = {
        id: 'https://openalex.org/W2741809807',
        doi: 'https://doi.org/10.1038/nature12345',
        title: 'Deep Learning in Genomics',
        display_name: 'Deep Learning in Genomics',
        publication_year: 2020,
        authorships: [
          { author: { display_name: 'Alice Johnson' } },
          { author: { display_name: 'Bob Smith' } },
        ],
        abstract_inverted_index: {
          Genomics: [0],
          is: [1],
          revolutionized: [2],
          by: [3],
          AI: [4],
        },
        primary_location: {
          source: { display_name: 'Nature Biotechnology' },
        },
        concepts: [
          { display_name: 'Genomics' },
          { display_name: 'Deep Learning' },
        ],
        cited_by_count: 142,
        open_access: {
          is_oa: true,
          oa_url: 'https://nature.com/article.pdf',
        },
        type: 'journal-article',
      };

      const result = provider.transformPayload(mockData);

      expect(result.title).toBe('Deep Learning in Genomics');
      expect(result.doi).toBe('10.1038/nature12345');
      expect(result.authors).toEqual(['Alice Johnson', 'Bob Smith']);
      expect(result.year).toBe(2020);
      expect(result.abstract).toBe('Genomics is revolutionized by AI');
      expect(result.journal).toBe('Nature Biotechnology');
      expect(result.citationCount).toBe(142);
      expect(result.provenance?.originProvider).toBe('OpenAlex');
      expect(result.provenance?.canonicalId).toBe('doi:10.1038/nature12345');
      expect(result.provenance?.isOpenAccess).toBe(true);
    });

    it('fetches by DOI via mocked fetch', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            id: 'https://openalex.org/W123',
            title: 'Quantum Advantage',
            publication_year: 2021,
            authorships: [],
            type: 'journal-article',
          }),
      } as any);

      const res = await provider.fetchByDoi('10.1038/s41586-020-03102-4');
      expect(res).not.toBeNull();
      expect(res?.title).toBe('Quantum Advantage');
      expect(res?.provenance?.originProvider).toBe('OpenAlex');
    });
  });

  describe('ArxivProvider', () => {
    let provider: ArxivProvider;

    beforeEach(() => {
      provider = new ArxivProvider();
    });

    it('parses arXiv XML response and extracts structured metadata', () => {
      const mockXml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/1706.03762v5</id>
    <published>2017-06-12T17:57:34Z</published>
    <title>Attention Is All You Need</title>
    <summary>The dominant sequence transduction models are based on complex recurrent neural networks.</summary>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Noam Shazeer</name></author>
    <arxiv:doi>10.5555/3295222.3295349</arxiv:doi>
    <arxiv:comment>15 pages, 5 figures</arxiv:comment>
    <category term="cs.CL"/>
    <category term="cs.AI"/>
    <arxiv:primary_category term="cs.CL"/>
  </entry>
</feed>`;

      const result = provider.parseXmlPayload(mockXml, '1706.03762');
      expect(result).not.toBeNull();
      expect(result?.title).toBe('Attention Is All You Need');
      expect(result?.authors).toEqual(['Ashish Vaswani', 'Noam Shazeer']);
      expect(result?.year).toBe(2017);
      expect(result?.publicationDate).toBe('2017-06-12');
      expect(result?.doi).toBe('10.5555/3295222.3295349');
      expect(result?.arxivId).toBe('1706.03762');
      expect(result?.keywords).toEqual(['cs.CL', 'cs.AI']);
      expect(result?.provenance?.originProvider).toBe('arXiv');
      expect(result?.provenance?.canonicalId).toBe('arxiv:1706.03762');
    });

    it('returns null on invalid or error XML', () => {
      const errorXml = `<feed><entry><id>http://arxiv.org/api/errors/1</id></entry></feed>`;
      expect(provider.parseXmlPayload(errorXml, '9999.99999')).toBeNull();
    });
  });

  describe('PubmedProvider', () => {
    let provider: PubmedProvider;

    beforeEach(() => {
      provider = new PubmedProvider();
    });

    it('transforms PubMed E-Utilities JSON payload', () => {
      const mockItem = {
        uid: '29124373',
        title: 'Deep learning in medical image analysis.',
        pubdate: '2017 Nov',
        authors: [{ name: 'Shen D' }, { name: 'Wu G' }, { name: 'Suk HI' }],
        source: 'Annu Rev Biomed Eng',
        fulljournalname: 'Annual review of biomedical engineering',
        volume: '19',
        pages: '221-248',
        articleids: [
          { idtype: 'pubmed', value: '29124373' },
          { idtype: 'doi', value: '10.1146/annurev-bioeng-071516-044442' },
          { idtype: 'pmc', value: '5780210' },
        ],
      };

      const result = provider.transformPayload(mockItem, '29124373');
      expect(result.title).toBe('Deep learning in medical image analysis');
      expect(result.authors).toEqual(['Shen D', 'Wu G', 'Suk HI']);
      expect(result.year).toBe(2017);
      expect(result.pmid).toBe('29124373');
      expect(result.pmcid).toBe('PMC5780210');
      expect(result.doi).toBe('10.1146/annurev-bioeng-071516-044442');
      expect(result.journal).toBe('Annual review of biomedical engineering');
      expect(result.provenance?.originProvider).toBe('PubMed');
      expect(result.provenance?.canonicalId).toBe('pmid:29124373');
      expect(result.provenance?.isOpenAccess).toBe(true);
    });
  });

  describe('OpenlibraryProvider', () => {
    let provider: OpenlibraryProvider;

    beforeEach(() => {
      provider = new OpenlibraryProvider();
    });

    it('transforms OpenLibrary book payload', () => {
      const mockItem = {
        title: 'Introduction to Algorithms',
        authors: [
          { name: 'Thomas H. Cormen' },
          { name: 'Charles E. Leiserson' },
        ],
        publish_date: '2009',
        publishers: [{ name: 'MIT Press' }],
        number_of_pages: 1292,
        url: 'https://openlibrary.org/books/OL12345M',
      };

      const result = provider.transformPayload(mockItem, '9780262033848');
      expect(result.title).toBe('Introduction to Algorithms');
      expect(result.authors).toEqual([
        'Thomas H. Cormen',
        'Charles E. Leiserson',
      ]);
      expect(result.year).toBe(2009);
      expect(result.isbn).toBe('9780262033848');
      expect(result.publisher).toBe('MIT Press');
      expect(result.pages).toBe('1292');
      expect(result.itemType).toBe('book');
      expect(result.provenance?.originProvider).toBe('OpenLibrary');
      expect(result.provenance?.canonicalId).toBe('isbn:9780262033848');
    });
  });

  describe('SemanticScholarProvider', () => {
    let provider: SemanticScholarProvider;

    beforeEach(() => {
      provider = new SemanticScholarProvider();
    });

    it('transforms Semantic Scholar Graph API payload', () => {
      const mockData = {
        paperId: '204e3073870fae3d05bcbc2f6a8e263c9b72e776',
        title: 'Attention Is All You Need',
        authors: [{ name: 'Ashish Vaswani' }, { name: 'Noam Shazeer' }],
        year: 2017,
        venue: 'NIPS',
        abstract: 'The dominant sequence transduction models...',
        tldr: {
          text: 'We propose the Transformer, a model architecture relying entirely on attention mechanisms.',
        },
        citationCount: 95000,
        fieldsOfStudy: ['Computer Science'],
        publicationTypes: ['Conference'],
        externalIds: {
          DOI: '10.5555/3295222.3295349',
          ArXiv: '1706.03762',
        },
        openAccessPdf: {
          url: 'https://arxiv.org/pdf/1706.03762.pdf',
        },
      };

      const result = provider.transformPayload(mockData);
      expect(result.title).toBe('Attention Is All You Need');
      expect(result.authors).toEqual(['Ashish Vaswani', 'Noam Shazeer']);
      expect(result.year).toBe(2017);
      expect(result.doi).toBe('10.5555/3295222.3295349');
      expect(result.arxivId).toBe('1706.03762');
      expect(result.itemType).toBe('conferencePaper');
      expect(result.tldr).toContain('We propose the Transformer');
      expect(result.citationCount).toBe(95000);
      expect(result.provenance?.originProvider).toBe('SemanticScholar');
      expect(result.provenance?.canonicalId).toBe(
        'doi:10.5555/3295222.3295349',
      );
    });
  });

  describe('UnpaywallProvider', () => {
    let provider: UnpaywallProvider;

    beforeEach(() => {
      provider = new UnpaywallProvider();
    });

    it('resolves OA status and PDF URL via Unpaywall', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            doi: '10.1038/nature12345',
            is_oa: true,
            oa_status: 'gold',
            best_oa_location: {
              url_for_pdf: 'https://nature.com/articles/nature12345.pdf',
            },
            title: 'Genomic Discovery',
          }),
      } as any);

      const res = await provider.resolveOaPdf('10.1038/nature12345');
      expect(res).not.toBeNull();
      expect(res?.isOa).toBe(true);
      expect(res?.pdfUrl).toBe('https://nature.com/articles/nature12345.pdf');
    });
  });

  describe('DoiResolver (CrossRef)', () => {
    let resolver: DoiResolver;

    beforeEach(() => {
      resolver = new DoiResolver();
    });

    it('resolves and cleans CrossRef work metadata', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            message: {
              DOI: '10.1038/nature12345',
              title: ['Single-cell RNA sequencing at scale'],
              author: [
                { given: 'John', family: 'Doe' },
                { family: 'Smith', given: 'Jane' },
              ],
              'published-print': { 'date-parts': [[2021, 5, 12]] },
              'container-title': ['Nature'],
              publisher: 'Nature Publishing Group',
              volume: '593',
              page: '120-128',
            },
          }),
      } as any);

      const res = await resolver.resolve('https://doi.org/10.1038/nature12345');
      expect(res).not.toBeNull();
      expect(res?.doi).toBe('10.1038/nature12345');
      expect(res?.title).toBe('Single-cell RNA sequencing at scale');
      expect(res?.authors).toEqual(['Doe, John', 'Smith, Jane']);
      expect(res?.year).toBe(2021);
      expect(res?.journal).toBe('Nature');
      expect(res?.provenance?.originProvider).toBe('CrossRef');
      expect(res?.provenance?.canonicalId).toBe('doi:10.1038/nature12345');
    });
  });
});
