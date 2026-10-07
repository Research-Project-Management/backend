import { UrlCaptureProvider } from '@/modules/library/ingestion/providers/url-capture.provider';
import { UrlMetadataScraperService } from '@/modules/library/ingestion/services/url-metadata-scraper.service';
import { SsrfGuardService } from '@/modules/library/shared-kernel/core/services/ssrf-guard.service';

describe('UrlCaptureProvider (Local-First In-Process Academic Scraping)', () => {
  let mockUrlScraper: { scrape: jest.Mock };
  let mockSsrfGuard: { assertSafeUrl: jest.Mock };
  let provider: UrlCaptureProvider;

  beforeEach(() => {
    mockUrlScraper = {
      scrape: jest.fn(),
    };

    mockSsrfGuard = {
      assertSafeUrl: jest.fn().mockResolvedValue(new URL('https://nature.com')),
    };

    process.env.URL_CAPTURE_SECRET =
      'a-very-long-secret-key-that-is-at-least-32-chars-long';

    provider = new UrlCaptureProvider(
      undefined,
      mockSsrfGuard as any,
      mockUrlScraper as any,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('Fast-Path: captures academic metadata directly via in-process UrlMetadataScraperService', async () => {
    mockUrlScraper.scrape!.mockResolvedValueOnce({
      url: 'https://nature.com/articles/s41586-021-03819-2',
      isPdf: false,
      title: 'Highly accurate protein structure prediction with AlphaFold',
      authors: ['John Jumper', 'Richard Evans', 'Alexander Pritzel'],
      creators: [
        { firstName: 'John', lastName: 'Jumper', fullName: 'John Jumper' },
        { firstName: 'Richard', lastName: 'Evans', fullName: 'Richard Evans' },
        {
          firstName: 'Alexander',
          lastName: 'Pritzel',
          fullName: 'Alexander Pritzel',
        },
      ],
      doi: '10.1038/s41586-021-03819-2',
      year: 2021,
      journal: 'Nature',
      publisher: 'Nature Publishing Group',
      abstract:
        'Proteins are essential to life, and understanding their structure can provide key insights into their function.',
      pdfUrl: 'https://nature.com/articles/s41586-021-03819-2.pdf',
    });

    const result = await provider.captureFromUrl(
      'https://nature.com/articles/s41586-021-03819-2',
      { scopeId: 'test-user', userId: 'test-user' },
    );

    // Verify In-process scraper was called
    expect(mockUrlScraper.scrape).toHaveBeenCalledWith(
      'https://nature.com/articles/s41586-021-03819-2',
      { scopeId: 'test-user', userId: 'test-user' },
    );

    // Verify captured metadata
    expect(result.title).toBe(
      'Highly accurate protein structure prediction with AlphaFold',
    );
    expect(result.doi).toBe('10.1038/s41586-021-03819-2');
    expect(result.journal).toBe('Nature');
    expect(result.year).toBe(2021);
    expect(result.itemType).toBe('journalArticle');
    expect(result.authors).toHaveLength(3);
    expect(result.extraFields?.source).toBe('InProcessUrlScraper');
    expect(result.previewToken).toBeDefined();
  });

  it('Fallback: handles web pages when in-process scraper returns non-academic page title', async () => {
    // In-process scraper returns minimal non-authoritative page
    mockUrlScraper.scrape!.mockResolvedValueOnce({
      url: 'https://example.com/blog-post',
      isPdf: false,
      title: 'Generic Blog Post',
    });

    const result = await provider.captureFromUrl(
      'https://example.com/blog-post',
    );

    expect(mockUrlScraper.scrape).toHaveBeenCalled();
    expect(result.title).toBe('Generic Blog Post');
    expect(result.itemType).toBe('webpage');
    expect(result.previewToken).toBeDefined();
  });

  it('Gracefully produces fallback when in-process scraper fails or returns empty', async () => {
    mockUrlScraper.scrape!.mockRejectedValueOnce(new Error('Network offline'));

    const result = await provider.captureFromUrl(
      'https://example.com/unreachable',
    );

    expect(result.title).toBe('Web Page');
    expect(result.itemType).toBe('webpage');
    expect(result.url).toBe('https://example.com/unreachable');
  });
});
