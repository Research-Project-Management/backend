import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../core/database/prisma.service';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

export interface BurnableAnnotation {
  pageIndex: number;
  type?: string;
  color?: string;
  quoteText?: string;
  comment?: string;
  rectCoords?: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    rects?: Array<{ x: number; y: number; width: number; height: number }>;
  };
}

@Injectable()
export class PdfExportService {
  private readonly logger = new Logger(PdfExportService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Embeds highlights, rectangular bounding boxes, and comments directly into PDF pages.
   */
  async burnAnnotationsToPdf(
    rawPdfBuffer: Buffer | Uint8Array,
    annotations: BurnableAnnotation[],
  ): Promise<Uint8Array> {
    const pdfDoc = await PDFDocument.load(rawPdfBuffer);
    const pages = pdfDoc.getPages();
    const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);

    for (const ann of annotations) {
      if (ann.pageIndex < 0 || ann.pageIndex >= pages.length) {
        continue;
      }

      const page = pages[ann.pageIndex];
      const { height: pageHeight } = page.getSize();
      const highlightColor = this.parseColor(ann.color);

      // 1. Draw Bounding Rectangles / Highlights
      const rectList: Array<{
        x: number;
        y: number;
        width: number;
        height: number;
      }> = [];
      if (ann.rectCoords?.rects && Array.isArray(ann.rectCoords.rects)) {
        rectList.push(...ann.rectCoords.rects);
      } else if (
        ann.rectCoords?.x !== undefined &&
        ann.rectCoords?.y !== undefined &&
        ann.rectCoords?.width !== undefined &&
        ann.rectCoords?.height !== undefined
      ) {
        rectList.push({
          x: ann.rectCoords.x,
          y: ann.rectCoords.y,
          width: ann.rectCoords.width,
          height: ann.rectCoords.height,
        });
      }

      for (const r of rectList) {
        // Adjust Y coordinates if coordinate origin is top-left
        const adjustedY = r.y > pageHeight ? pageHeight - r.y : r.y;
        page.drawRectangle({
          x: Math.max(0, r.x),
          y: Math.max(0, adjustedY),
          width: Math.max(1, r.width),
          height: Math.max(1, r.height),
          color: highlightColor,
          opacity: 0.35,
        });
      }

      // 2. Draw Sticky Note / Comment Margin Indicator
      if (ann.comment && ann.comment.trim()) {
        const commentY = rectList[0]?.y ?? 40;
        const safeY = Math.min(Math.max(20, commentY), pageHeight - 40);

        page.drawText(`[Note: ${ann.comment.trim().slice(0, 80)}]`, {
          x: 20,
          y: safeY,
          size: 8,
          font: helvetica,
          color: rgb(0.2, 0.2, 0.2),
        });
      }
    }

    return pdfDoc.save();
  }

  /**
   * Exports an annotated PDF for a specific CatalogItem.
   */
  async exportAnnotatedItemPdf(
    workspaceId: string,
    itemId: string,
    rawPdfBuffer?: Buffer,
  ): Promise<{ filename: string; buffer: Uint8Array }> {
    const item = await this.prisma.catalogItem.findFirst({
      where: { id: itemId, workspaceId, deletedAt: null },
      include: {
        attachments: true,
      },
    });

    if (!item) {
      throw new NotFoundException('Catalog item not found');
    }

    const pdfAttachment =
      item.attachments.find((a) => a.mimeType === 'application/pdf') ||
      item.attachments[0];

    if (!pdfAttachment && !rawPdfBuffer) {
      throw new NotFoundException('No PDF attachment found for this item');
    }

    const annotations = await this.prisma.annotation.findMany({
      where: {
        attachmentId: pdfAttachment?.id,
        deletedAt: null,
      },
      orderBy: { pageIndex: 'asc' },
    });

    // If no buffer passed, create minimal placeholder PDF if empty, or throw
    let bufferToUse = rawPdfBuffer;
    if (!bufferToUse) {
      const doc = await PDFDocument.create();
      const page = doc.addPage([595.28, 841.89]); // A4
      const font = await doc.embedFont(StandardFonts.Helvetica);
      page.drawText(item.title, { x: 50, y: 780, size: 14, font });
      if (item.doi) {
        page.drawText(`DOI: ${item.doi}`, { x: 50, y: 760, size: 10, font });
      }
      bufferToUse = Buffer.from(await doc.save());
    }

    const burned = await this.burnAnnotationsToPdf(
      bufferToUse,
      annotations as unknown as BurnableAnnotation[],
    );

    const safeFilename = `${item.title.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60)}_annotated.pdf`;

    return {
      filename: safeFilename,
      buffer: burned,
    };
  }

  private parseColor(colorStr?: string) {
    if (!colorStr) return rgb(1, 0.9, 0.2); // Default yellow highlight
    const s = colorStr.toLowerCase().trim();
    if (s === 'green' || s.includes('#22c55e')) return rgb(0.2, 0.8, 0.4);
    if (s === 'blue' || s.includes('#3b82f6')) return rgb(0.3, 0.6, 1);
    if (s === 'pink' || s.includes('#ec4899')) return rgb(1, 0.4, 0.7);
    if (s === 'orange' || s.includes('#f97316')) return rgb(1, 0.6, 0.2);
    return rgb(1, 0.9, 0.2);
  }
}
