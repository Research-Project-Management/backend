import { UnpaywallProvider } from '@/modules/library/ingestion/metadata/providers/unpaywall.provider';
import { ProviderFetchError } from '@/modules/library/ingestion/metadata/metadata.executor';

describe('UnpaywallProvider (Standalone)', () => {
  let provider: UnpaywallProvider;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    provider = new UnpaywallProvider();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('has correct capabilities', () => {
    expect(provider.id).toBe('Unpaywall');
    expect(provider.supports('DOI')).toBe(true);
    expect(provider.supports('ARXIV')).toBe(false);
    expect(provider.supports('TITLE')).toBe(false);
  });

  it('resolves OA PDF URL from Unpaywall API response', async () => {
    const mockJson = {
      is_oa: true,
      best_oa_location: {
        url_for_pdf: 'https://oa.example.com/paper.pdf',
      },
      title: 'Open Access Research',
      journal_name: 'Nature Communications',
    };

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue(mockJson),
    } as any);

    const res = await provider.resolve({ query: '10.1234/test' });
    expect(res).not.toBeNull();
    expect(res?.provider).toBe('Unpaywall');
    expect(res?.metadata.openAccessPdfUrl).toBe(
      'https://oa.example.com/paper.pdf',
    );
    expect(res?.confidence).toBeCloseTo(0.99);
  });

  it('returns null when no PDF URL is available in response', async () => {
    const mockJson = {
      is_oa: false,
      best_oa_location: null,
    };

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue(mockJson),
    } as any);

    const res = await provider.resolve({ query: '10.1234/test' });
    expect(res).toBeNull();
  });

  it('throws ProviderFetchError on 503 error', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      headers: new Headers(),
    } as any);

    await expect(provider.resolve({ query: '10.1234/test' })).rejects.toThrow(
      ProviderFetchError,
    );
  });
});
