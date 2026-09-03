import {
  PdfExportService,
  BurnableAnnotation,
} from '../../../../src/modules/library/exports/pdf-export.service';
import { PDFDocument, StandardFonts } from 'pdf-lib';

describe('PdfExportService (Unit)', () => {
  let service: PdfExportService;
  let mockPrisma: any;

  beforeEach(() => {
    mockPrisma = {
      catalogItem: {
        findFirst: jest.fn(),
      },
      annotation: {
        findMany: jest.fn(),
      },
    };
    service = new PdfExportService(mockPrisma);
  });

  it('burns highlight rectangles and text notes into a multi-page PDF', async () => {
    // Generate a minimal valid 2-page PDF
    const doc = await PDFDocument.create();
    const page1 = doc.addPage([600, 800]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page1.drawText('Sample Academic Research Paper', {
      x: 50,
      y: 750,
      size: 16,
      font,
    });
    const page2 = doc.addPage([600, 800]);
    page2.drawText('Second page content and references', {
      x: 50,
      y: 750,
      size: 14,
      font,
    });
    const rawBuffer = await doc.save();

    const annotations: BurnableAnnotation[] = [
      {
        pageIndex: 0,
        type: 'highlight',
        color: 'yellow',
        rectCoords: {
          x: 50,
          y: 745,
          width: 250,
          height: 20,
        },
        comment: 'Key hypothesis',
      },
      {
        pageIndex: 1,
        type: 'highlight',
        color: 'green',
        rectCoords: {
          rects: [{ x: 50, y: 745, width: 200, height: 18 }],
        },
      },
    ];

    const burned = await service.burnAnnotationsToPdf(rawBuffer, annotations);
    expect(burned).toBeInstanceOf(Uint8Array);
    expect(burned.length).toBeGreaterThan(rawBuffer.length);

    // Verify burned document can be loaded back cleanly
    const loadedDoc = await PDFDocument.load(burned);
    expect(loadedDoc.getPageCount()).toBe(2);
  });

  it('handles empty annotations gracefully', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([500, 500]);
    const rawBuffer = await doc.save();

    const burned = await service.burnAnnotationsToPdf(rawBuffer, []);
    expect(burned).toBeInstanceOf(Uint8Array);
    expect(burned.length).toBeGreaterThan(0);
  });
});
