import { ArxivProvider } from '@/modules/library/ingestion/metadata/providers/arxiv.provider';
import { ProviderFetchError } from '@/modules/library/ingestion/metadata/services/provider.executor';

describe('ArxivProvider (Standalone)', () => {
  let provider: ArxivProvider;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    provider = new ArxivProvider();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('has correct capabilities', () => {
    expect(provider.id).toBe('arXiv');
    expect(provider.supports('ARXIV')).toBe(true);
    expect(provider.supports('DOI')).toBe(false);
  });

  it('resolves arXiv entry successfully from XML response', async () => {
    const mockXml = `
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <id>http://arxiv.org/abs/1706.03762v5</id>
          <published>2017-06-12T17:57:34Z</published>
          <title>Attention Is All You Need</title>
          <summary>The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.</summary>
          <author><name>Ashish Vaswani</name></author>
          <author><name>Noam Shazeer</name></author>
          <category term="cs.LG" />
          <category term="cs.CL" />
          <arxiv:doi xmlns:arxiv="http://arxiv.org/schemas/atom">10.5555/3295222</arxiv:doi>
        </entry>
      </feed>
    `;

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: jest.fn().mockResolvedValue(mockXml),
    } as any);

    const res = await provider.resolve({ query: '1706.03762' });
    expect(res).not.toBeNull();
    expect(res?.provider).toBe('arXiv');
    expect(res?.metadata.title).toBe('Attention Is All You Need');
    expect(res?.metadata.authors).toEqual(['Ashish Vaswani', 'Noam Shazeer']);
    expect(res?.metadata.year).toBe(2017);
    expect(res?.metadata.doi).toBe('10.5555/3295222');
    expect(res?.metadata.openAccessPdfUrl).toBe(
      'https://arxiv.org/pdf/1706.03762.pdf',
    );
    expect(res?.metadata.keywords).toEqual(['cs.LG', 'cs.CL']);
    expect(res?.metadata.tags).toEqual(['cs.LG', 'cs.CL']);
    expect(res?.metadata.extraFields).toMatchObject({
      repository: 'arXiv',
      archiveId: '1706.03762',
    });
    expect(res?.metadata.extraFields).not.toHaveProperty('archiveID');
  });

  it('returns null on 404', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
    } as any);

    const res = await provider.resolve({ query: '1706.99999' });
    expect(res).toBeNull();
  });

  it('throws ProviderFetchError on 503', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      headers: new Headers(),
    } as any);

    await expect(provider.resolve({ query: '1706.03762' })).rejects.toThrow(
      ProviderFetchError,
    );
  });
});
