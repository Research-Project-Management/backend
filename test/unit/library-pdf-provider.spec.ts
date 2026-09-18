import { getDocumentProxy, getMeta } from 'unpdf';
import { PdfProvider } from '../../src/modules/library/attachments/providers/pdf.provider';

jest.mock('unpdf', () => ({
  extractText: jest.fn(),
  getDocumentProxy: jest.fn(),
  getMeta: jest.fn(),
}));

describe('PdfProvider', () => {
  const mockedGetDocumentProxy = getDocumentProxy as jest.Mock;
  const mockedGetMeta = getMeta as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.PDF_MAX_INDEX_PAGES;
  });

  it('indexes every page by default instead of truncating after page 25', async () => {
    mockedGetMeta.mockResolvedValue({ info: {} });
    mockedGetDocumentProxy.mockResolvedValue({
      numPages: 30,
      getPage: jest.fn(async (pageNumber: number) => ({
        getTextContent: jest.fn().mockResolvedValue({
          items: [{ str: `Page ${pageNumber} contains enough searchable text for indexing.` }],
        }),
      })),
    });

    const provider = new PdfProvider();
    const result = await provider.extractDocumentFromBuffer(Buffer.from('%PDF fixture'));

    expect(result.pages).toHaveLength(30);
    expect(result.pages[29].textContent).toContain('Page 30');
  });

  it('uses OCR when a page has no usable text layer', async () => {
    mockedGetMeta.mockResolvedValue({ info: {} });
    const page = {
      getTextContent: jest.fn().mockResolvedValue({ items: [] }),
    };
    mockedGetDocumentProxy.mockResolvedValue({
      numPages: 1,
      getPage: jest.fn().mockResolvedValue(page),
    });
    const ocr = {
      enabled: true,
      maxPages: 50,
      recognizePdfPage: jest.fn().mockResolvedValue('Scanned article text from OCR'),
    };

    const provider = new PdfProvider(undefined, undefined, ocr as any);
    const result = await provider.extractDocumentFromBuffer(Buffer.from('%PDF scan'));

    expect(ocr.recognizePdfPage).toHaveBeenCalledWith(page, 0);
    expect(result.pages[0].textContent).toBe('Scanned article text from OCR');
  });

  it('keeps header-only identification bounded to the first three pages', async () => {
    mockedGetMeta.mockResolvedValue({ info: {} });
    const getPage = jest.fn(async () => ({
      getTextContent: jest.fn().mockResolvedValue({
        items: [{ str: 'A sufficiently long page of bibliographic text.' }],
      }),
    }));
    mockedGetDocumentProxy.mockResolvedValue({ numPages: 20, getPage });

    const provider = new PdfProvider();
    const result = await provider.extractDocumentFromBuffer(
      Buffer.from('%PDF fixture'),
      { headerOnly: true },
    );

    expect(result.pages).toHaveLength(3);
    expect(getPage).toHaveBeenCalledTimes(3);
  });
});
