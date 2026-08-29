import { SemanticScholarProvider } from '@/modules/library/ingestion/metadata/providers/semantic-scholar.provider';
import { ProviderFetchError } from '@/modules/library/ingestion/metadata/metadata.executor';

describe('SemanticScholarProvider (Standalone)', () => {
  let provider: SemanticScholarProvider;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    provider = new SemanticScholarProvider();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('has correct capabilities', () => {
    expect(provider.id).toBe('SemanticScholar');
    expect(provider.supports('DOI')).toBe(true);
    expect(provider.supports('ARXIV')).toBe(true);
    expect(provider.supports('PMID')).toBe(true);
    expect(provider.supports('TITLE')).toBe(true);
    expect(provider.supports('URL')).toBe(true);
  });

  it('resolves paper by DOI via S2 Graph API', async () => {
    const mockJson = {
      title: 'Attention Is All You Need',
      authors: [{ name: 'Ashish Vaswani' }],
      year: 2017,
      venue: 'NeurIPS',
      externalIds: { DOI: '10.5555/3295222', ArXiv: '1706.03762' },
      abstract: 'The dominant sequence transduction models...',
      tldr: { text: 'We propose the Transformer model.' },
      openAccessPdf: { url: 'https://arxiv.org/pdf/1706.03762.pdf' },
      citationCount: 90000,
    };

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue(mockJson),
    } as any);

    const res = await provider.resolve({ query: '10.5555/3295222' });
    expect(res).not.toBeNull();
    expect(res?.provider).toBe('SemanticScholar');
    expect(res?.metadata.title).toBe('Attention Is All You Need');
    expect(res?.metadata.tldr).toBe('We propose the Transformer model.');
    expect(res?.metadata.openAccessPdfUrl).toBe(
      'https://arxiv.org/pdf/1706.03762.pdf',
    );
    expect(res?.confidence).toBeCloseTo(0.9);
  });

  it('searches by title when query is not an identifier', async () => {
    const mockJson = {
      data: [
        {
          title: 'Attention Is All You Need',
          authors: [{ name: 'Ashish Vaswani' }],
          year: 2017,
        },
      ],
    };

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue(mockJson),
    } as any);

    const res = await provider.resolve({ query: 'Attention Is All You Need' });
    expect(res?.metadata.title).toBe('Attention Is All You Need');
    expect(res?.confidence).toBeCloseTo(0.8);
  });

  it('throws ProviderFetchError on 429 rate limit with Retry-After', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers({ 'retry-after': '60' }),
    } as any);

    await expect(
      provider.resolve({ query: '10.5555/3295222' }),
    ).rejects.toThrow(ProviderFetchError);
  });
});
