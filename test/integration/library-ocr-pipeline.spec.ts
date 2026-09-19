import { getDocumentProxy, getMeta } from 'unpdf';
import { PdfProvider } from '../../src/modules/library/attachments/providers/pdf.provider';
import { OcrProvider } from '../../src/modules/library/attachments/providers/ocr.provider';
import { OcrSandwichPdfService } from '../../src/modules/library/attachments/ocr/ocr-sandwich-pdf.service';
import { PDFDocument } from 'pdf-lib';

jest.mock('unpdf', () => ({
  extractText: jest.fn(),
  getDocumentProxy: jest.fn(),
  getMeta: jest.fn(),
}));

describe('Library OCR Pipeline (Integration)', () => {
  let pdfProvider: PdfProvider;
  let ocrProvider: OcrProvider;
  let sandwichService: OcrSandwichPdfService;
  const mockedGetDocumentProxy = getDocumentProxy as jest.Mock;
  const mockedGetMeta = getMeta as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

    sandwichService = new OcrSandwichPdfService();

    ocrProvider = {
      enabled: true,
      maxPages: 50,
      detectScannedPage: jest.fn().mockResolvedValue({
        pageIndex: 0,
        isScanned: true,
        isHybrid: false,
        textLength: 0,
        textDensityRatio: 0,
        hasLargeImage: true,
        reason: 'Sparse text layer',
      }),
      recognizePdfPage: jest.fn().mockResolvedValue({
        pageIndex: 0,
        text: 'Nghiên cứu Trí tuệ Nhân tạo 2026',
        confidence: 95.2,
        orientationAngle: 0,
        skewAngle: 0,
        preprocessed: true,
        executionTimeMs: 210,
        wasOcr: true,
        blocks: [
          {
            text: 'Nghiên cứu Trí tuệ Nhân tạo 2026',
            confidence: 95.2,
            bbox: { x0: 50, y0: 80, x1: 400, y1: 120 },
            lines: [
              {
                text: 'Nghiên cứu Trí tuệ Nhân tạo 2026',
                confidence: 95.2,
                bbox: { x0: 50, y0: 80, x1: 400, y1: 120 },
                words: [
                  {
                    text: 'Nghiên',
                    confidence: 96,
                    bbox: { x0: 50, y0: 80, x1: 120, y1: 120 },
                  },
                  {
                    text: 'cứu',
                    confidence: 95,
                    bbox: { x0: 130, y0: 80, x1: 180, y1: 120 },
                  },
                  {
                    text: 'Trí',
                    confidence: 95,
                    bbox: { x0: 190, y0: 80, x1: 230, y1: 120 },
                  },
                  {
                    text: 'tuệ',
                    confidence: 94,
                    bbox: { x0: 240, y0: 80, x1: 280, y1: 120 },
                  },
                  {
                    text: 'Nhân',
                    confidence: 96,
                    bbox: { x0: 290, y0: 80, x1: 340, y1: 120 },
                  },
                  {
                    text: 'tạo',
                    confidence: 95,
                    bbox: { x0: 350, y0: 80, x1: 400, y1: 120 },
                  },
                ],
              },
            ],
          },
        ],
        words: [
          {
            text: 'Nghiên',
            confidence: 96,
            bbox: { x0: 50, y0: 80, x1: 120, y1: 120 },
          },
          {
            text: 'cứu',
            confidence: 95,
            bbox: { x0: 130, y0: 80, x1: 180, y1: 120 },
          },
          {
            text: 'Trí',
            confidence: 95,
            bbox: { x0: 190, y0: 80, x1: 230, y1: 120 },
          },
          {
            text: 'tuệ',
            confidence: 94,
            bbox: { x0: 240, y0: 80, x1: 280, y1: 120 },
          },
          {
            text: 'Nhân',
            confidence: 96,
            bbox: { x0: 290, y0: 80, x1: 340, y1: 120 },
          },
          {
            text: 'tạo',
            confidence: 95,
            bbox: { x0: 350, y0: 80, x1: 400, y1: 120 },
          },
        ],
      }),
      generateSearchablePdf: jest
        .fn()
        .mockImplementation((buf, results) =>
          sandwichService.generateSearchablePdf(buf, results),
        ),
    } as any;

    pdfProvider = new PdfProvider(undefined, undefined, ocrProvider);
  });

  it('detects scanned page, executes OCR, generates Sandwich PDF and produces OCR provenance', async () => {
    // 1. Create a minimal valid PDF buffer using pdf-lib
    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([600, 800]);
    const scannedPdfBuffer = Buffer.from(await pdfDoc.save());

    // 2. Mock unpdf document proxy to simulate an image-only page (no text items)
    mockedGetMeta.mockResolvedValue({ info: {} });
    const mockPage = {
      getTextContent: jest.fn().mockResolvedValue({ items: [] }),
      getViewport: jest.fn().mockReturnValue({ width: 600, height: 800 }),
    };
    mockedGetDocumentProxy.mockResolvedValue({
      numPages: 1,
      getPage: jest.fn().mockResolvedValue(mockPage),
    });

    // 3. Run through PdfProvider
    const result =
      await pdfProvider.extractDocumentFromBuffer(scannedPdfBuffer);

    // 4. Assertions
    expect(ocrProvider.detectScannedPage).toHaveBeenCalled();
    expect(ocrProvider.recognizePdfPage).toHaveBeenCalled();
    expect(ocrProvider.generateSearchablePdf).toHaveBeenCalled();

    // Verify page content was replaced with OCR result
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].textContent).toContain(
      'Nghiên cứu Trí tuệ Nhân tạo 2026',
    );

    // Verify OCR provenance
    expect(result.ocrProvenance).toBeDefined();
    expect(result.ocrProvenance?.totalOcrPages).toBe(1);
    expect(result.ocrProvenance?.avgConfidence).toBeCloseTo(95.2, 1);
    expect(result.ocrProvenance?.pages[0].pageIndex).toBe(0);
    expect(result.ocrProvenance?.pages[0].confidence).toBeCloseTo(95.2, 1);

    // Verify Searchable Sandwich PDF output
    expect(result.searchablePdfBuffer).toBeDefined();
    expect(result.searchablePdfBuffer?.length).toBeGreaterThan(
      scannedPdfBuffer.length,
    );
  });
});
