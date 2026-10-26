import { RetractionScannerProvider } from '@/modules/library/ingestion/providers/retraction-scanner.provider';
import { RetractionDatabaseService } from '@/modules/library/ingestion/services/retraction-database.service';

describe('RetractionScannerProvider', () => {
  let provider: RetractionScannerProvider;
  let mockDbService: Partial<RetractionDatabaseService>;

  beforeEach(() => {
    mockDbService = {
      checkRetraction: jest.fn().mockResolvedValue(null),
      saveClean: jest.fn().mockResolvedValue(undefined),
      saveRetraction: jest.fn().mockResolvedValue(undefined),
    };

    provider = new RetractionScannerProvider(
      mockDbService as RetractionDatabaseService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should return retracted immediately if found in fast local database cache', async () => {
    (mockDbService.checkRetraction as jest.Mock).mockResolvedValue({
      nature: 'retraction',
      reason: 'Falsified data',
      source: 'retraction_watch',
    });

    const result = await provider.lookup('10.1016/sample-retracted');

    expect(result.status).toBe('retracted');
    expect((result as any).details?.nature).toBe('retraction');
    expect(mockDbService.checkRetraction).toHaveBeenCalled();
  });

  it('should return clean immediately if DOI is in negative clean cache', async () => {
    (mockDbService.checkRetraction as jest.Mock).mockResolvedValue(false);

    const result = await provider.lookup('10.1007/sample-clean');

    expect(result.status).toBe('clean');
    expect(mockDbService.checkRetraction).toHaveBeenCalledWith(
      '10.1007/sample-clean',
      undefined,
    );
  });

  it('should detect retraction via OpenAlex registry (Retraction Watch integration)', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        ({
          ok: true,
          json: async () => ({
            is_retracted: true,
            doi: '10.1016/sample-retracted',
            publication_date: '2020-01-01',
          }),
        }) as any,
    );

    const result = await provider.lookup('10.1016/sample-retracted');

    expect(result.status).toBe('retracted');
    expect((result as any).details?.source).toBe('openalex');
    expect((result as any).details?.nature).toBe('retraction');
    expect(mockDbService.saveRetraction).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('should detect retraction via CrossRef CrossMark publisher update notice', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (url: any) => {
        const urlStr = String(url);
        if (urlStr.includes('openalex.org')) {
          return {
            ok: true,
            json: async () => ({ is_retracted: false }),
          } as any;
        }
        if (urlStr.includes('crossref.org')) {
          return {
            ok: true,
            json: async () => ({
              message: {
                'update-to': [
                  {
                    type: 'retraction',
                    label: 'Retracted by editorial board',
                    doi: '10.1000/notice-doi',
                    updated: { 'date-time': '2023-05-01T00:00:00Z' },
                  },
                ],
              },
            }),
          } as any;
        }
        return { ok: false } as any;
      });

    const result = await provider.lookup('10.1000/updated-paper');

    expect(result.status).toBe('retracted');
    expect((result as any).details?.source).toBe('crossref');
    expect((result as any).details?.noticeUrl).toBe(
      'https://doi.org/10.1000/notice-doi',
    );
    expect(mockDbService.saveRetraction).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('should detect expression of concern via CrossRef', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (url: any) => {
        const urlStr = String(url);
        if (urlStr.includes('openalex.org')) {
          return {
            ok: true,
            json: async () => ({ is_retracted: false }),
          } as any;
        }
        if (urlStr.includes('crossref.org')) {
          return {
            ok: true,
            json: async () => ({
              message: {
                'update-to': [
                  {
                    type: 'expression_of_concern',
                    label: 'Data integrity investigation pending',
                  },
                ],
              },
            }),
          } as any;
        }
        return { ok: false } as any;
      });

    const result = await provider.lookup('10.1000/concern-paper');

    expect(result.status).toBe('retracted');
    expect((result as any).details?.nature).toBe('expression_of_concern');
    fetchSpy.mockRestore();
  });

  it('should mark paper as clean and cache clean status when both APIs report clean', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (url: any) => {
        const urlStr = String(url);
        if (urlStr.includes('openalex.org')) {
          return {
            ok: true,
            json: async () => ({ is_retracted: false }),
          } as any;
        }
        if (urlStr.includes('crossref.org')) {
          return {
            ok: true,
            json: async () => ({ message: {} }),
          } as any;
        }
        return { ok: false } as any;
      });

    const result = await provider.lookup('10.1007/valid-paper');

    expect(result.status).toBe('clean');
    expect(mockDbService.saveClean).toHaveBeenCalledWith(
      '10.1007/valid-paper',
      undefined,
    );
    fetchSpy.mockRestore();
  });

  it('should return unknown gracefully if external calls fail', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => {
        throw new Error('Network timeout');
      });

    const result = await provider.lookup('10.1007/timeout-paper');

    expect(result.status).toBe('unknown');
    expect(mockDbService.saveClean).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('should delegate to AcademicHttpClient without infinite recursion when injected via NestJS DI', async () => {
    const mockHttpClient = {
      request: jest.fn().mockResolvedValue({
        response: {
          ok: true,
          json: async () => ({
            is_retracted: true,
            doi: '10.1038/retracted-via-httpclient',
            publication_date: '2024-02-15',
          }),
        },
        finalUrl: 'https://api.openalex.org/works/https%3A%2F%2Fdoi.org%2F10.1038%2Fretracted-via-httpclient',
      }),
    };

    const diProvider = new RetractionScannerProvider(
      mockDbService as RetractionDatabaseService,
      mockHttpClient as any,
    );

    const result = await diProvider.lookup('10.1038/retracted-via-httpclient');

    expect(result.status).toBe('retracted');
    expect((result as any).details?.source).toBe('openalex');
    expect(mockHttpClient.request).toHaveBeenCalledTimes(1);
    expect(mockDbService.saveRetraction).toHaveBeenCalledWith(
      '10.1038/retracted-via-httpclient',
      expect.objectContaining({ nature: 'retraction', source: 'openalex' }),
      undefined,
    );
  });

  it('should skip external HTTP lookups when localOnly: true is passed during bulk batch ingestion', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');

    const result = await provider.lookup('10.1007/unindexed-batch-paper', undefined, {
      localOnly: true,
    });

    expect(result.status).toBe('unknown');
    expect(mockDbService.checkRetraction).toHaveBeenCalledWith(
      '10.1007/unindexed-batch-paper',
      undefined,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
