import { PubMedProvider } from '@/modules/library/ingestion/metadata/providers/pubmed.provider';
import { ProviderFetchError } from '@/modules/library/ingestion/metadata/metadata.executor';

describe('PubMedProvider (Standalone)', () => {
  let provider: PubMedProvider;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    provider = new PubMedProvider();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('has correct capabilities', () => {
    expect(provider.id).toBe('PubMed');
    expect(provider.supports('PMID')).toBe(true);
    expect(provider.supports('DOI')).toBe(false);
  });

  it('resolves PMID successfully from E-Utilities summary JSON', async () => {
    const mockJson = {
      result: {
        '12345678': {
          title: 'A Novel Biomedical Discovery.',
          authors: [{ name: 'Smith J' }, { name: 'Doe A' }],
          pubdate: '2023 Jan 15',
          fulljournalname: 'Journal of Biological Chemistry',
          articleids: [
            { idtype: 'pubmed', value: '12345678' },
            { idtype: 'doi', value: '10.1074/jbc.1234' },
            { idtype: 'pmc', value: 'PMC999999' },
          ],
        },
      },
    };

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue(mockJson),
    } as any);

    const res = await provider.resolve({ query: '12345678' });
    expect(res).not.toBeNull();
    expect(res?.provider).toBe('PubMed');
    expect(res?.metadata.title).toBe('A Novel Biomedical Discovery');
    expect(res?.metadata.authors).toEqual(['Smith J', 'Doe A']);
    expect(res?.metadata.year).toBe(2023);
    expect(res?.metadata.doi).toBe('10.1074/jbc.1234');
    expect(res?.metadata.pmcid).toBe('PMC999999');
    expect(res?.confidence).toBeCloseTo(0.97);
  });

  it('throws ProviderFetchError on 500 error', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      headers: new Headers(),
    } as any);

    await expect(provider.resolve({ query: '12345678' })).rejects.toThrow(
      ProviderFetchError,
    );
  });
});
