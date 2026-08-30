import { OpenAlexProvider } from '@/modules/library/ingestion/metadata/providers/openalex.provider';
import { ProviderFetchError } from '@/modules/library/ingestion/metadata/services/provider.executor';

describe('OpenAlexProvider (Standalone)', () => {
  let provider: OpenAlexProvider;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    provider = new OpenAlexProvider();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('has correct capabilities', () => {
    expect(provider.id).toBe('OpenAlex');
    expect(provider.supports('DOI')).toBe(true);
    expect(provider.supports('TITLE')).toBe(true);
    expect(provider.supports('ARXIV')).toBe(false);
  });

  it('resolves DOI and decodes inverted index abstract', async () => {
    const mockJson = {
      title: 'Attention Is All You Need',
      authorships: [{ author: { display_name: 'Ashish Vaswani' } }],
      publication_year: 2017,
      doi: 'https://doi.org/10.5555/3295222',
      primary_location: {
        source: {
          display_name: 'Advances in Neural Information Processing Systems',
        },
        pdf_url: 'https://arxiv.org/pdf/1706.03762.pdf',
      },
      abstract_inverted_index: {
        The: [0],
        Transformer: [1],
        is: [2],
        great: [3],
      },
      open_access: {
        is_oa: true,
        oa_url: 'https://arxiv.org/pdf/1706.03762.pdf',
      },
      cited_by_count: 95000,
    };

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue(mockJson),
    } as any);

    const res = await provider.resolve({ query: '10.5555/3295222' });
    expect(res).not.toBeNull();
    expect(res?.provider).toBe('OpenAlex');
    expect(res?.metadata.title).toBe('Attention Is All You Need');
    expect(res?.metadata.abstract).toBe('The Transformer is great');
    expect(res?.metadata.openAccessPdfUrl).toBe(
      'https://arxiv.org/pdf/1706.03762.pdf',
    );
    expect(res?.confidence).toBeCloseTo(0.9);
  });

  it('throws ProviderFetchError on 500 error', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      headers: new Headers(),
    } as any);

    await expect(
      provider.resolve({ query: '10.5555/3295222' }),
    ).rejects.toThrow(ProviderFetchError);
  });
});
