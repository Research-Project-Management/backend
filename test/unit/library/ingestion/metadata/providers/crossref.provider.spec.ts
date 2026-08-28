import { CrossRefProvider } from '@/modules/library/ingestion/metadata/providers/crossref.provider';
import { ProviderFetchError } from '@/modules/library/ingestion/metadata/metadata.executor';

describe('CrossRefProvider (Standalone)', () => {
  let provider: CrossRefProvider;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    provider = new CrossRefProvider();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('has correct capabilities', () => {
    expect(provider.id).toBe('CrossRef');
    expect(provider.supports('DOI')).toBe(true);
    expect(provider.supports('TITLE')).toBe(true);
    expect(provider.supports('ARXIV')).toBe(false);
  });

  it('resolves DOI successfully via CrossRef API', async () => {
    const mockPayload = {
      message: {
        title: ['Attention Is All You Need'],
        author: [{ family: 'Vaswani', given: 'Ashish' }],
        issued: { 'date-parts': [[2017]] },
        'container-title': ['NeurIPS'],
        DOI: '10.5555/3295222',
        URL: 'https://doi.org/10.5555/3295222',
      },
    };

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue(mockPayload),
    } as any);

    const res = await provider.resolve({ query: '10.5555/3295222' });
    expect(res).not.toBeNull();
    expect(res?.provider).toBe('CrossRef');
    expect(res?.metadata.title).toBe('Attention Is All You Need');
    expect(res?.metadata.authors).toEqual(['Vaswani, Ashish']);
    expect(res?.metadata.year).toBe(2017);
    expect(res?.confidence).toBeCloseTo(0.99);
  });

  it('returns null on 404', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
    } as any);

    const res = await provider.resolve({ query: '10.9999/notfound' });
    expect(res).toBeNull();
  });

  it('throws ProviderFetchError on 500 server error', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      headers: new Headers(),
    } as any);

    await expect(
      provider.resolve({ query: '10.5555/3295222' }),
    ).rejects.toThrow(ProviderFetchError);
  });

  it('searches by title when query is not a DOI', async () => {
    const mockPayload = {
      message: {
        items: [
          {
            title: ['Attention Is All You Need'],
            author: [{ name: 'Vaswani et al.' }],
            DOI: '10.5555/3295222',
          },
        ],
      },
    };

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue(mockPayload),
    } as any);

    const res = await provider.resolve({ query: 'Attention Is All You Need' });
    expect(res?.metadata.title).toBe('Attention Is All You Need');
    expect(res?.confidence).toBeCloseTo(0.85);
  });
});
