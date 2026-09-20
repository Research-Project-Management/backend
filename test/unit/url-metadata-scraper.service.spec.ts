import { UrlMetadataScraperService } from '../../src/modules/library/processing/application/services/url-metadata-scraper.service';
import { SsrfGuardService } from '../../src/modules/library/shared-kernel/core/services/ssrf-guard.service';
import { IStoragePort } from '../../src/modules/storage/storage.port';
import { IContentFacade } from '../../src/modules/library/content/content.facade';

describe('UrlMetadataScraperService', () => {
  let scraper: UrlMetadataScraperService;
  let ssrfGuard: jest.Mocked<SsrfGuardService>;
  let storagePort: jest.Mocked<IStoragePort>;
  let contentFacade: jest.Mocked<IContentFacade>;

  beforeEach(() => {
    ssrfGuard = {
      assertSafeUrl: jest
        .fn()
        .mockResolvedValue(new URL('https://example.com')),
    } as any;

    storagePort = {
      uploadFile: jest.fn().mockResolvedValue({
        fileId: 'file-storage-id',
        url: 'https://storage.flux.local/file-storage-id.pdf',
        filename: 'paper.pdf',
        mimeType: 'application/pdf',
        size: 12345,
        path: '/storage/file-storage-id.pdf',
      }),
    } as any;

    contentFacade = {
      extractDocumentFromBuffer: jest.fn().mockResolvedValue({
        metadata: {
          title: 'Extracted PDF Title',
          authors: ['Ashish Vaswani'],
          year: 2017,
        },
        pages: [],
      }),
    } as any;

    scraper = new UrlMetadataScraperService(
      storagePort,
      contentFacade,
      ssrfGuard,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects unsafe SSRF URLs', async () => {
    ssrfGuard.assertSafeUrl.mockRejectedValueOnce(
      new Error('Target resolves to private network'),
    );

    const result = await scraper.scrape('http://192.168.1.1/paper.pdf');
    expect(result).not.toBeNull();
    expect(ssrfGuard.assertSafeUrl).toHaveBeenCalledWith(
      'http://192.168.1.1/paper.pdf',
    );
    expect(result.fileId).toBeUndefined();
  });

  it('scrapes Highwire Press academic HTML metadata', async () => {
    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta name="citation_title" content="Attention Is All You Need">
        <meta name="citation_author" content="Vaswani, Ashish">
        <meta name="citation_author" content="Noam Shazeer">
        <meta name="citation_publication_date" content="2017/12/04">
        <meta name="citation_doi" content="10.5555/3295222.3295349">
        <meta name="citation_conference_title" content="Advances in Neural Information Processing Systems (NeurIPS)">
      </head>
      <body></body>
      </html>
    `;

    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      text: jest.fn().mockResolvedValueOnce(htmlContent),
    } as any);

    const result = await scraper.scrape(
      'https://proceedings.neurips.cc/paper/7181-attention-is-all-you-need',
    );
    expect(result).not.toBeNull();
    expect(result.title).toBe('Attention Is All You Need');
    expect(result.year).toBe(2017);
    expect(result.doi).toBe('10.5555/3295222.3295349');
    expect(result.creators).toEqual([
      {
        firstName: 'Ashish',
        lastName: 'Vaswani',
        fullName: 'Ashish Vaswani',
        creatorType: 'author',
      },
      {
        firstName: 'Noam',
        lastName: 'Shazeer',
        fullName: 'Noam Shazeer',
        creatorType: 'author',
      },
    ]);
    expect(result.publicationTitle).toBe(
      'Advances in Neural Information Processing Systems (NeurIPS)',
    );
  });

  it('scrapes OpenGraph and standard title if academic tags are absent', async () => {
    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Deep Residual Learning for Image Recognition | CVPR</title>
        <meta property="og:description" content="Deeper neural networks are more difficult to train.">
      </head>
      <body></body>
      </html>
    `;

    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      text: jest.fn().mockResolvedValueOnce(htmlContent),
    } as any);

    const result = await scraper.scrape(
      'https://openaccess.thecvf.com/content_cvpr_2016/html/He_Deep_Residual_Learning_2016_CVPR_paper.html',
    );
    expect(result).not.toBeNull();
    expect(result.title).toBe('Deep Residual Learning for Image Recognition');
    expect(result.abstract).toBe(
      'Deeper neural networks are more difficult to train.',
    );
  });

  it('downloads direct PDF, extracts metadata, and saves to storage', async () => {
    const pdfBuffer = Buffer.from(
      '%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF',
    );

    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'application/pdf' }),
      arrayBuffer: jest
        .fn()
        .mockResolvedValueOnce(
          pdfBuffer.buffer.slice(
            pdfBuffer.byteOffset,
            pdfBuffer.byteOffset + pdfBuffer.byteLength,
          ),
        ),
    } as any);

    const result = await scraper.scrape(
      'https://proceedings.neurips.cc/paper/7181-attention-is-all-you-need.pdf?utm_source=chatgpt.com',
    );
    expect(result).not.toBeNull();
    expect(storagePort.uploadFile).toHaveBeenCalled();
    expect(result.fileId).toBe('file-storage-id');
    expect(result.title).toBe('Extracted PDF Title');
    expect(result.year).toBe(2017);
  });

  it('falls back to humanized filename slug when PDF extraction returns untitled', async () => {
    contentFacade.extractDocumentFromBuffer.mockResolvedValueOnce({
      metadata: {},
      pages: [],
    });
    const pdfBuffer = Buffer.from(
      '%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF',
    );

    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'application/pdf' }),
      arrayBuffer: jest
        .fn()
        .mockResolvedValueOnce(
          pdfBuffer.buffer.slice(
            pdfBuffer.byteOffset,
            pdfBuffer.byteOffset + pdfBuffer.byteLength,
          ),
        ),
    } as any);

    const result = await scraper.scrape(
      'https://proceedings.neurips.cc/paper/7181-attention-is-all-you-need.pdf?utm_source=chatgpt.com',
    );
    expect(result).not.toBeNull();
    expect(result.title).toBe('Attention Is All You Need');
  });
});
