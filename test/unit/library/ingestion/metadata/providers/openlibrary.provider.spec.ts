import { OpenLibraryProvider } from '@/modules/library/ingestion/metadata/providers/openlibrary.provider';
import { ProviderFetchError } from '@/modules/library/ingestion/metadata/metadata.executor';

describe('OpenLibraryProvider (Standalone)', () => {
  let provider: OpenLibraryProvider;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    provider = new OpenLibraryProvider();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('has correct capabilities', () => {
    expect(provider.id).toBe('OpenLibrary');
    expect(provider.supports('ISBN')).toBe(true);
    expect(provider.supports('DOI')).toBe(false);
  });

  it('resolves ISBN successfully from OpenLibrary API', async () => {
    const mockJson = {
      'ISBN:9780316769174': {
        title: 'The Catcher in the Rye',
        authors: [{ name: 'J.D. Salinger' }],
        publish_date: '1951',
        publishers: [{ name: 'Little, Brown' }],
        number_of_pages: 277,
      },
    };

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue(mockJson),
    } as any);

    const res = await provider.resolve({ query: '9780316769174' });
    expect(res).not.toBeNull();
    expect(res?.provider).toBe('OpenLibrary');
    expect(res?.metadata.title).toBe('The Catcher in the Rye');
    expect(res?.metadata.authors).toEqual(['J.D. Salinger']);
    expect(res?.metadata.year).toBe(1951);
    expect(res?.metadata.itemType).toBe('book');
    expect(res?.confidence).toBeCloseTo(0.95);
  });

  it('throws ProviderFetchError on network / server failure', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 502,
      headers: new Headers(),
    } as any);

    await expect(provider.resolve({ query: '9780316769174' })).rejects.toThrow(
      ProviderFetchError,
    );
  });
});
