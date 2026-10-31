import { Injectable } from '@nestjs/common';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { BurnableAnnotation } from '@/modules/library/citation/types/exports.types';

export type { BurnableAnnotation };

@Injectable()
export class PdfBakerService {
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
      const { width: pageWidth, height: pageHeight } = page.getSize();
      const highlightColor = this.parseColor(ann.color);

      // 1. Draw Bounding Rectangles / Highlights
      const rectList: Array<{
        x: number;
        y: number;
        width: number;
        height: number;
      }> = [];
      const rawCoords = ann.rectCoords as unknown;
      if (Array.isArray(rawCoords)) {
        if (
          rawCoords.length === 4 &&
          rawCoords.every((c) => typeof c === 'number')
        ) {
          const [x1, y1, x2, y2] = rawCoords as [
            number,
            number,
            number,
            number,
          ];
          const isNormalized = x2 <= 1 && y2 <= 1;
          rectList.push({
            x: isNormalized ? x1 * pageWidth : x1,
            y: isNormalized ? (1 - y2) * pageHeight : y1,
            width: isNormalized ? (x2 - x1) * pageWidth : x2 - x1,
            height: isNormalized ? (y2 - y1) * pageHeight : y2 - y1,
          });
        } else {
          for (const item of rawCoords) {
            if (item && typeof item === 'object') {
              const r = item as Record<string, unknown>;
              const rx = Number(r.x ?? r.x1 ?? 0);
              const ry = Number(r.y ?? r.y1 ?? 0);
              const rw = Number(
                r.width ?? (r.x2 !== undefined ? Number(r.x2) - rx : 0),
              );
              const rh = Number(
                r.height ?? (r.y2 !== undefined ? Number(r.y2) - ry : 0),
              );
              const isNormalized = rx <= 1 && ry <= 1 && rw <= 1 && rh <= 1;
              rectList.push({
                x: isNormalized ? rx * pageWidth : rx,
                y: isNormalized ? (1 - (ry + rh)) * pageHeight : ry,
                width: isNormalized ? rw * pageWidth : rw,
                height: isNormalized ? rh * pageHeight : rh,
              });
            }
          }
        }
      } else if (ann.rectCoords?.rects && Array.isArray(ann.rectCoords.rects)) {
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
        const safeComment = this.sanitizeForPdf(ann.comment.trim()).slice(
          0,
          80,
        );

        if (safeComment) {
          page.drawText(`[Note: ${safeComment}]`, {
            x: 20,
            y: safeY,
            size: 8,
            font: helvetica,
            color: rgb(0.2, 0.2, 0.2),
          });
        }
      }
    }

    return pdfDoc.save();
  }

  private sanitizeForPdf(text: string): string {
    if (!text) return '';
    return text
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[đĐ]/g, (m) => (m === 'đ' ? 'd' : 'D'))
      .replace(/[^\x20-\x7E\xA0-\xFF]/g, ' ')
      .trim();
  }

  parseColor(colorStr?: string) {
    if (!colorStr) return rgb(1, 0.9, 0.2); // Default yellow highlight
    const s = colorStr.toLowerCase().trim();
    if (s === 'red' || s.includes('#ff6666') || s.includes('#f44336'))
      return rgb(1, 0.4, 0.4);
    if (
      s === 'green' ||
      s.includes('#22c55e') ||
      s.includes('#5fb236') ||
      s.includes('#4caf50')
    )
      return rgb(0.2, 0.8, 0.4);
    if (
      s === 'blue' ||
      s.includes('#3b82f6') ||
      s.includes('#2ea8e5') ||
      s.includes('#2196f3')
    )
      return rgb(0.3, 0.6, 1);
    if (s === 'purple' || s.includes('#a28ae5') || s.includes('#9c27b0'))
      return rgb(0.64, 0.54, 0.9);
    if (
      s === 'pink' ||
      s === 'magenta' ||
      s.includes('#ec4899') ||
      s.includes('#e56eee')
    )
      return rgb(1, 0.4, 0.7);
    if (s === 'orange' || s.includes('#f97316') || s.includes('#f19837'))
      return rgb(1, 0.6, 0.2);
    return rgb(1, 0.9, 0.2);
  }
}
