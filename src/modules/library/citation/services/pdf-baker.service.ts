import { Injectable } from '@nestjs/common';
import {
  PDFDocument,
  PDFName,
  PDFHexString,
  rgb,
  StandardFonts,
} from 'pdf-lib';
import { BurnableAnnotation } from '@/modules/library/citation/types/citation.types';

export type { BurnableAnnotation };

@Injectable()
export class PdfBakerService {
  /**
   * Normalizes any W3C / Flux annotation rect representation (4-number tuple,
   * array of rect objects, `{ rects: [...] }`, or single `{ x, y, width, height }`)
   * from Top-Left origin (either normalized [0, 1] or PDF point coordinates)
   * into canonical PDF Bottom-Left point coordinates `{ x, y, width, height }`.
   */
  private extractPdfRects(
    rawCoords: unknown,
    pageWidth: number,
    pageHeight: number,
  ): Array<{ x: number; y: number; width: number; height: number }> {
    if (!rawCoords) return [];

    const toPdfRect = (
      rawX: number,
      rawY: number,
      rawW: number,
      rawH: number,
    ): { x: number; y: number; width: number; height: number } | null => {
      if (
        !Number.isFinite(rawX) ||
        !Number.isFinite(rawY) ||
        !Number.isFinite(rawW) ||
        !Number.isFinite(rawH) ||
        rawW <= 0 ||
        rawH <= 0
      ) {
        return null;
      }

      const isNormalized =
        rawX >= 0 &&
        rawY >= 0 &&
        rawX <= 1 &&
        rawY <= 1 &&
        rawW <= 1 &&
        rawH <= 1 &&
        rawX + rawW <= 1.05 &&
        rawY + rawH <= 1.05;

      if (isNormalized) {
        return {
          x: rawX * pageWidth,
          y: (1 - (rawY + rawH)) * pageHeight,
          width: rawW * pageWidth,
          height: rawH * pageHeight,
        };
      }

      const flippedY = Math.max(
        0,
        Math.min(pageHeight, pageHeight - (rawY + rawH)),
      );
      return {
        x: rawX,
        y: flippedY,
        width: rawW,
        height: rawH,
      };
    };

    const parseEntry = (
      entry: unknown,
    ): { x: number; y: number; width: number; height: number } | null => {
      if (
        Array.isArray(entry) &&
        entry.length === 4 &&
        entry.every((c) => typeof c === 'number')
      ) {
        const [x1, y1, x2, y2] = entry as [number, number, number, number];
        const minX = Math.min(x1, x2);
        const maxX = Math.max(x1, x2);
        const minY = Math.min(y1, y2);
        const maxY = Math.max(y1, y2);
        return toPdfRect(minX, minY, maxX - minX, maxY - minY);
      }

      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        const r = entry as Record<string, unknown>;
        const rx = Number(r.x ?? r.x1 ?? NaN);
        const ry = Number(r.y ?? r.y1 ?? NaN);
        const rw = Number(
          r.width ?? (r.x2 !== undefined ? Number(r.x2) - rx : NaN),
        );
        const rh = Number(
          r.height ?? (r.y2 !== undefined ? Number(r.y2) - ry : NaN),
        );
        return toPdfRect(rx, ry, rw, rh);
      }

      return null;
    };

    const rectList: Array<{
      x: number;
      y: number;
      width: number;
      height: number;
    }> = [];

    if (Array.isArray(rawCoords)) {
      if (
        rawCoords.length === 4 &&
        rawCoords.every((c) => typeof c === 'number')
      ) {
        const parsed = parseEntry(rawCoords);
        if (parsed) rectList.push(parsed);
      } else {
        for (const item of rawCoords) {
          const parsed = parseEntry(item);
          if (parsed) rectList.push(parsed);
        }
      }
      return rectList;
    }

    if (typeof rawCoords === 'object') {
      const obj = rawCoords as { rects?: unknown[] };
      if (Array.isArray(obj.rects)) {
        for (const item of obj.rects) {
          const parsed = parseEntry(item);
          if (parsed) rectList.push(parsed);
        }
        return rectList;
      }

      const single = parseEntry(rawCoords);
      if (single) rectList.push(single);
    }

    return rectList;
  }

  /**
   * Embeds highlights, underlines, strikethroughs, rectangular bounding boxes, and comments directly into PDF pages.
   */
  async burnAnnotationsToPdf(
    rawPdfBuffer: Buffer | Uint8Array,
    annotations: BurnableAnnotation[],
    options?: { mode?: 'interactive' | 'flattened' | 'hybrid' },
  ): Promise<Uint8Array> {
    const mode = options?.mode ?? 'hybrid';
    const shouldDrawFlattened = mode === 'flattened' || mode === 'hybrid';
    const shouldEmbedInteractive = mode === 'interactive' || mode === 'hybrid';

    const pdfDoc = await PDFDocument.load(rawPdfBuffer);
    const pages = pdfDoc.getPages();
    const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);

    const hasZeroBased = annotations.some((a) => a.pageIndex === 0);
    const hasOneBasedPageLabel = annotations.some(
      (a) =>
        a.pageIndex >= 1 &&
        typeof a.pageLabel === 'string' &&
        a.pageLabel.trim() === String(a.pageIndex),
    );
    const hasOutOfZeroBounds = annotations.some(
      (a) => a.pageIndex === pages.length && pages.length > 0,
    );
    const batchIsOneBased =
      !hasZeroBased && (hasOneBasedPageLabel || hasOutOfZeroBounds);

    let processedCount = 0;
    for (const ann of annotations) {
      const isAnnOneBased =
        ann.pageIndex >= 1 &&
        (batchIsOneBased ||
          (typeof ann.pageLabel === 'string' &&
            ann.pageLabel.trim() === String(ann.pageIndex)) ||
          ann.pageIndex === pages.length);
      const targetPageIndex = isAnnOneBased ? ann.pageIndex - 1 : ann.pageIndex;

      if (targetPageIndex < 0 || targetPageIndex >= pages.length) {
        continue;
      }

      processedCount++;
      if (processedCount % 50 === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }

      const page = pages[targetPageIndex];
      const { width: pageWidth, height: pageHeight } = page.getSize();
      const rgbChannels = this.parseColorRgbArray(ann.color);
      const highlightColor = rgb(rgbChannels[0], rgbChannels[1], rgbChannels[2]);
      const annotType = (ann.type || 'highlight').toLowerCase();

      // 1. Draw Bounding Rectangles / Highlights / Underlines / Strikes / Ink
      const rectList = this.extractPdfRects(
        ann.rectCoords,
        pageWidth,
        pageHeight,
      );

      let drewInkStrokes = false;
      const inkPathsList: number[][] = [];
      if (annotType === 'ink' && Array.isArray(ann.rectCoords)) {
        for (const rawEntry of ann.rectCoords) {
          if (
            rawEntry &&
            typeof rawEntry === 'object' &&
            !Array.isArray(rawEntry) &&
            Array.isArray((rawEntry as { paths?: unknown }).paths)
          ) {
            const entryObj = rawEntry as {
              x1?: number;
              y1?: number;
              x2?: number;
              y2?: number;
              width?: number;
              height?: number;
              paths: unknown[];
            };
            const rx1 = typeof entryObj.x1 === 'number' ? entryObj.x1 : 0;
            const ry1 = typeof entryObj.y1 === 'number' ? entryObj.y1 : 0;
            const rw =
              typeof entryObj.width === 'number' && entryObj.width > 0
                ? entryObj.width
                : typeof entryObj.x2 === 'number'
                  ? Math.max(0.01, entryObj.x2 - rx1)
                  : 1;
            const rh =
              typeof entryObj.height === 'number' && entryObj.height > 0
                ? entryObj.height
                : typeof entryObj.y2 === 'number'
                  ? Math.max(0.01, entryObj.y2 - ry1)
                  : 1;

            for (const stroke of entryObj.paths) {
              const pagePoints: Array<{ x: number; y: number }> = [];

              if (typeof stroke === 'string') {
                // Parse SVG path string "M rx ry L rx ry ..." where rx, ry are in [0, 100] relative to entry bounding box
                const cmdRegex = /[ML]\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/gi;
                let match: RegExpExecArray | null;
                while ((match = cmdRegex.exec(stroke)) !== null) {
                  const pctX = Number(match[1]);
                  const pctY = Number(match[2]);
                  if (Number.isFinite(pctX) && Number.isFinite(pctY)) {
                    const normX = rx1 + (pctX / 100) * rw;
                    const normY = ry1 + (pctY / 100) * rh;
                    const px = normX * pageWidth;
                    const py = (1 - normY) * pageHeight;
                    if (Number.isFinite(px) && Number.isFinite(py)) {
                      pagePoints.push({ x: px, y: py });
                    }
                  }
                }
              } else if (Array.isArray(stroke) && stroke.length >= 2) {
                for (const pt of stroke) {
                  if (Array.isArray(pt) && pt.length >= 2) {
                    const px = Number(pt[0]) * pageWidth;
                    const py = (1 - Number(pt[1])) * pageHeight;
                    if (Number.isFinite(px) && Number.isFinite(py)) {
                      pagePoints.push({ x: px, y: py });
                    }
                  }
                }
              }

              if (pagePoints.length >= 2) {
                const flatInkStroke: number[] = [];
                for (let i = 0; i < pagePoints.length; i++) {
                  flatInkStroke.push(pagePoints[i].x, pagePoints[i].y);
                  if (shouldDrawFlattened && i > 0) {
                    page.drawLine({
                      start: pagePoints[i - 1],
                      end: pagePoints[i],
                      thickness: 1.75,
                      color: highlightColor,
                      opacity: 0.9,
                    });
                    drewInkStrokes = true;
                  }
                }
                if (flatInkStroke.length >= 4) {
                  inkPathsList.push(flatInkStroke);
                }
              }
            }
          }
        }
      }

      if (shouldDrawFlattened && !drewInkStrokes) {
        for (const r of rectList) {
          const x = Math.max(0, r.x);
          const y = Math.max(0, r.y);
          const w = Math.max(1, r.width);
          const h = Math.max(1, r.height);

          if (annotType === 'underline') {
            page.drawLine({
              start: { x, y },
              end: { x: x + w, y },
              thickness: 1.25,
              color: highlightColor,
              opacity: 0.85,
            });
          } else if (annotType === 'strike' || annotType === 'strikeout') {
            const midY = y + h * 0.45;
            page.drawLine({
              start: { x, y: midY },
              end: { x: x + w, y: midY },
              thickness: 1.25,
              color: highlightColor,
              opacity: 0.85,
            });
          } else if (annotType === 'rect' || annotType === 'area') {
            page.drawRectangle({
              x,
              y,
              width: w,
              height: h,
              borderColor: highlightColor,
              borderWidth: 1.5,
              color: highlightColor,
              opacity: 0.1,
              borderOpacity: 0.85,
            });
          } else if (annotType === 'ink') {
            // Do not draw a solid rectangle fallback for ink annotations without stroke paths
          } else if (annotType === 'note') {
            page.drawRectangle({
              x,
              y,
              width: Math.max(12, Math.min(w, 18)),
              height: Math.max(12, Math.min(h, 18)),
              borderColor: highlightColor,
              borderWidth: 1.2,
              color: highlightColor,
              opacity: 0.85,
            });
          } else if (annotType === 'text') {
            const textBody = this.sanitizeForPdf(
              (ann.comment || ann.quoteText || '').trim(),
            ).slice(0, 120);
            if (textBody) {
              page.drawText(textBody, {
                x,
                y: Math.max(12, y + h - 10),
                size: 9,
                font: helvetica,
                color: highlightColor,
              });
            }
          } else {
            page.drawRectangle({
              x,
              y,
              width: w,
              height: h,
              color: highlightColor,
              opacity: 0.35,
            });
          }
        }
      }

      // 2. Embed Standard PDF /Annot Dictionary so external PDF viewers (Acrobat, Preview, Zotero) can inspect & edit
      if (
        shouldEmbedInteractive &&
        (rectList.length > 0 || (ann.comment && ann.comment.trim()))
      ) {
        try {
          let minX = 24;
          let minY = pageHeight - 48;
          let maxX = 44;
          let maxY = pageHeight - 28;
          if (rectList.length > 0) {
            minX = Infinity;
            minY = Infinity;
            maxX = -Infinity;
            maxY = -Infinity;
            for (const r of rectList) {
              if (r.x < minX) minX = r.x;
              if (r.y < minY) minY = r.y;
              if (r.x + r.width > maxX) maxX = r.x + r.width;
              if (r.y + r.height > maxY) maxY = r.y + r.height;
            }
          }

          const pdfSubtype =
            annotType === 'underline'
              ? 'Underline'
              : annotType === 'strike' || annotType === 'strikeout'
                ? 'StrikeOut'
                : annotType === 'rect' || annotType === 'area'
                  ? 'Square'
                  : annotType === 'ink'
                    ? 'Ink'
                    : annotType === 'note'
                      ? 'Text'
                      : annotType === 'text'
                        ? 'FreeText'
                        : 'Highlight';

          const quadPoints: number[] = [];
          for (const r of rectList) {
            const x1 = r.x;
            const y1 = r.y;
            const x2 = r.x + r.width;
            const y2 = r.y + r.height;
            quadPoints.push(x1, y2, x2, y2, x1, y1, x2, y1);
          }

          const contentsValue = (ann.comment || ann.quoteText || '').trim();
          const annotDict = pdfDoc.context.obj({
            Type: PDFName.of('Annot'),
            Subtype: PDFName.of(pdfSubtype),
            Rect: [minX, minY, maxX, maxY],
            ...(quadPoints.length > 0 &&
            (pdfSubtype === 'Highlight' ||
              pdfSubtype === 'Underline' ||
              pdfSubtype === 'StrikeOut')
              ? { QuadPoints: quadPoints }
              : {}),
            ...(pdfSubtype === 'Ink' && inkPathsList.length > 0
              ? { InkList: inkPathsList }
              : {}),
            C: rgbChannels,
            CA:
              mode === 'interactive'
                ? pdfSubtype === 'Highlight'
                  ? 0.45
                  : 0.9
                : 0,
            ...(contentsValue
              ? { Contents: PDFHexString.fromText(contentsValue) }
              : {}),
          });
          const annotRef = pdfDoc.context.register(annotDict);
          page.node.addAnnot(annotRef);
        } catch {
          // Non-fatal fallback if PDF page dictionary rejects custom /Annots ref
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

  private parseColorRgbArray(colorStr?: string): [number, number, number] {
    if (!colorStr) return [1, 0.83, 0];
    const clean = colorStr.trim().toLowerCase();
    const hex6 = clean.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/);
    if (hex6) {
      return [
        parseInt(hex6[1], 16) / 255,
        parseInt(hex6[2], 16) / 255,
        parseInt(hex6[3], 16) / 255,
      ];
    }
    const hex3 = clean.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/);
    if (hex3) {
      return [
        parseInt(hex3[1] + hex3[1], 16) / 255,
        parseInt(hex3[2] + hex3[2], 16) / 255,
        parseInt(hex3[3] + hex3[3], 16) / 255,
      ];
    }
    if (clean === 'gray' || clean === 'grey') return [0.67, 0.67, 0.67];
    if (clean === 'red') return [1, 0.4, 0.4];
    if (clean === 'green') return [0.37, 0.7, 0.21];
    if (clean === 'blue') return [0.18, 0.66, 0.9];
    if (clean === 'purple') return [0.64, 0.54, 0.9];
    if (clean === 'magenta' || clean === 'pink') return [0.9, 0.43, 0.93];
    if (clean === 'orange') return [0.95, 0.6, 0.22];
    return [1, 0.83, 0];
  }

}
