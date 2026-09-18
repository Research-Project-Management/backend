import { OcrSandwichPdfService } from '../../src/modules/library/attachments/ocr/ocr-sandwich-pdf.service';
import { PDFDocument } from 'pdf-lib';
import { OcrPageResult } from '../../src/modules/library/attachments/ocr/ocr.types';

describe('OcrSandwichPdfService', () => {
  let service: OcrSandwichPdfService;

  beforeEach(() => {
    service = new OcrSandwichPdfService();
  });

  it('embeds invisible text layer into scanned PDF without corrupting PDF format', async () => {
    // 1. Create a minimal 1-page blank PDF
    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([600, 800]);
    const originalBuffer = Buffer.from(await pdfDoc.save());

    // 2. Mock OCR results for page 0
    const mockPageResult: OcrPageResult = {
      pageIndex: 0,
      text: 'Deep Learning for Science',
      confidence: 94.5,
      orientationAngle: 0,
      skewAngle: 0,
      preprocessed: true,
      executionTimeMs: 150,
      wasOcr: true,
      blocks: [],
      words: [
        {
          text: 'Deep',
          confidence: 96,
          bbox: { x0: 40, y0: 60, x1: 120, y1: 90 },
        },
        {
          text: 'Learning',
          confidence: 95,
          bbox: { x0: 130, y0: 60, x1: 250, y1: 90 },
        },
        {
          text: 'Science',
          confidence: 93,
          bbox: { x0: 260, y0: 60, x1: 380, y1: 90 },
        },
      ],
    };

    // 3. Generate Sandwich PDF
    const resultBuffer = await service.generateSearchablePdf(
      originalBuffer,
      [mockPageResult],
    );

    expect(resultBuffer).toBeDefined();
    expect(resultBuffer.length).toBeGreaterThan(originalBuffer.length);
    expect(resultBuffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');

    // 4. Verify that the output is a valid loadable PDF with intact page structure
    const loadedDoc = await PDFDocument.load(resultBuffer);
    expect(loadedDoc.getPageCount()).toBe(1);

    const loadedPage = loadedDoc.getPage(0);
    expect(loadedPage.getWidth()).toBe(600);
    expect(loadedPage.getHeight()).toBe(800);
  });

  it('safely sanitizes Vietnamese diacritics to prevent WinAnsi encoding crashes in pdf-lib', async () => {
    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([600, 800]);
    const originalBuffer = Buffer.from(await pdfDoc.save());

    const mockVietnameseResult: OcrPageResult = {
      pageIndex: 0,
      text: 'Đại học Quốc gia Hà Nội - Nghiên cứu Khoa học',
      confidence: 92,
      orientationAngle: 0,
      skewAngle: 0,
      preprocessed: true,
      executionTimeMs: 180,
      wasOcr: true,
      blocks: [],
      words: [
        {
          text: 'Đại',
          confidence: 92,
          bbox: { x0: 40, y0: 50, x1: 90, y1: 80 },
        },
        {
          text: 'học',
          confidence: 91,
          bbox: { x0: 100, y0: 50, x1: 150, y1: 80 },
        },
        {
          text: 'Nghiên',
          confidence: 90,
          bbox: { x0: 160, y0: 50, x1: 240, y1: 80 },
        },
        {
          text: 'cứu',
          confidence: 93,
          bbox: { x0: 250, y0: 50, x1: 300, y1: 80 },
        },
      ],
    };

    // Should not throw WinAnsi error, and return a valid PDF document
    const resultBuffer = await service.generateSearchablePdf(
      originalBuffer,
      [mockVietnameseResult],
    );

    expect(resultBuffer).toBeDefined();
    expect(resultBuffer.length).toBeGreaterThan(originalBuffer.length);

    const loadedDoc = await PDFDocument.load(resultBuffer);
    expect(loadedDoc.getPageCount()).toBe(1);
  });
});
