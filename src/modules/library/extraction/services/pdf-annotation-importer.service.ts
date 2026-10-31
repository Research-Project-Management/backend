import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  Inject,
  Optional,
} from '@nestjs/common';
import { AnnotationsRepository } from '@/modules/library/extraction/repositories/annotations.repository';
import { AttachmentsRepository } from '@/modules/library/extraction/repositories/attachments.repository';
import { STORAGE_PORT, IStoragePort } from '@/modules/storage/storage.port';
import { AnnotationsService } from './annotations.service';
import { AnnotationType } from '@/modules/library/extraction/types/extraction.types';
import {
  AnnotationNormalizer,
  extractTopLeftAnchor,
} from '@/modules/library/extraction/domain/annotation.normalizer';
import {
  extractFileIdFromUrl,
  normalizeProjectScopeId,
} from '@/modules/library/core';
import { getDocumentProxy } from 'unpdf';

export interface ImportAnnotationsResult {
  imported: number;
  totalFound: number;
  pagesScanned: number;
}

@Injectable()
export class PdfAnnotationImporterService {
  private readonly logger = new Logger(PdfAnnotationImporterService.name);

  constructor(
    private readonly annotationsRepo: AnnotationsRepository,
    private readonly attachmentsRepo: AttachmentsRepository,
    @Inject(STORAGE_PORT) private readonly storagePort: IStoragePort,
    private readonly annotationsService: AnnotationsService,
    @Optional()
    private readonly normalizer: AnnotationNormalizer = new AnnotationNormalizer(),
  ) {}

  /**
   * Import annotations directly from the PDF file attached to attachmentId.
   * Reads standard PDF /Annots dictionaries (Highlight, Underline, StrikeOut, FreeText, Square)
   * and persists them as non-destructive W3C-compliant annotations in Flux.
   */
  async importFromAttachment(
    userId: string,
    attachmentId: string,
    projectId?: string,
  ): Promise<ImportAnnotationsResult> {
    const attachment = await this.attachmentsRepo.findUnique(attachmentId, {
      item: true,
    });

    if (!attachment || attachment.deletedAt) {
      throw new NotFoundException(`Attachment ${attachmentId} not found`);
    }

    const effectiveProjectId = normalizeProjectScopeId(projectId);
    if (attachment.item) {
      if (effectiveProjectId) {
        if (attachment.item.projectId !== effectiveProjectId) {
          throw new NotFoundException(`Attachment ${attachmentId} not found`);
        }
      } else if (attachment.item.userId && attachment.item.userId !== userId) {
        throw new NotFoundException(`Attachment ${attachmentId} not found`);
      } else if (attachment.item.projectId && !attachment.item.userId) {
        throw new NotFoundException(`Attachment ${attachmentId} not found`);
      }
    }

    const fileId = attachment.fileId || extractFileIdFromUrl(attachment.url);

    if (!fileId) {
      throw new BadRequestException(
        `Cannot locate stored PDF binary for attachment ${attachmentId}`,
      );
    }

    const resolvedProjectId =
      effectiveProjectId ||
      normalizeProjectScopeId(attachment.item?.projectId ?? undefined);
    const storageFile = await this.storagePort.readOwnedFile({
      fileId,
      userId,
      ...(resolvedProjectId ? { projectId: resolvedProjectId } : {}),
    });
    const buffer = storageFile.buffer;

    if (!buffer || buffer.byteLength === 0) {
      throw new BadRequestException(
        `Empty or corrupted PDF payload for attachment ${attachmentId}`,
      );
    }

    const clonedData = new Uint8Array(buffer.byteLength);
    clonedData.set(buffer);

    let documentProxy: Awaited<ReturnType<typeof getDocumentProxy>>;
    try {
      documentProxy = await this.loadPdfDocument(clonedData);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Failed to parse PDF document proxy for attachment ${attachmentId}: ${message}`,
      );
      throw new BadRequestException(
        `Failed to parse PDF structure: ${message || 'Invalid PDF'}`,
      );
    }

    try {
      const numPages = documentProxy.numPages || 0;
      if (numPages === 0) {
        return { imported: 0, totalFound: 0, pagesScanned: 0 };
      }

      const existingAnnotations =
        await this.annotationsRepo.findExistingForImport(attachmentId);

      let totalFound = 0;
      let imported = 0;
      const annotationsToCreate: Array<{
        type: AnnotationType;
        pageIndex: number;
        y: number;
        x: number;
        color: string;
        quoteText?: string;
        comment: string;
        rectCoords: Array<{
          x1: number;
          y1: number;
          x2: number;
          y2: number;
          width: number;
          height: number;
        }>;
        authorId: string;
      }> = [];

      for (let p = 1; p <= numPages; p++) {
        let page: Awaited<ReturnType<typeof documentProxy.getPage>> | undefined;
        try {
          page = await documentProxy.getPage(p);
          interface PdfRawAnnotation {
            subtype?: string;
            rect?: number[];
            quadPoints?: number[];
            color?: number[];
            contents?: string;
            contentsObj?: { str?: string } | null;
          }
          interface PdfTextItem {
            str?: string;
            transform?: number[];
            width?: number;
            height?: number;
            hasEOL?: boolean;
          }
          const annots = (await page.getAnnotations()) as
            PdfRawAnnotation[] | null | undefined;
          if (!annots || !Array.isArray(annots) || annots.length === 0) {
            continue;
          }

          let textItems: PdfTextItem[] | undefined;
          const loadTextItems = async (): Promise<PdfTextItem[]> => {
            if (textItems !== undefined) return textItems;
            try {
              if (typeof page?.getTextContent === 'function') {
                const tc = (await page.getTextContent()) as {
                  items?: PdfTextItem[];
                } | null;
                textItems = Array.isArray(tc?.items) ? tc.items : [];
              } else {
                textItems = [];
              }
            } catch {
              textItems = [];
            }
            return textItems;
          };

          const viewport =
            typeof page.getViewport === 'function'
              ? page.getViewport({ scale: 1.0 })
              : null;
          const [vx1 = 0, vy1 = 0, vx2 = 612, vy2 = 792] = page.view || [];
          const pageWidth = viewport?.width || Math.abs(vx2 - vx1) || 612;
          const pageHeight = viewport?.height || Math.abs(vy2 - vy1) || 792;
          const pageIndex = p - 1;

          for (const annot of annots) {
            const mappedType = this.mapSubtype(annot.subtype);
            if (!mappedType) continue;

            totalFound++;

            const normalizedRects = this.parseNormalizedRects(
              annot.quadPoints,
              annot.rect,
              pageWidth,
              pageHeight,
            );
            if (normalizedRects.length === 0) continue;

            const primaryRect = normalizedRects[0];
            const normX1 = primaryRect.x1;
            const normY1 = primaryRect.y1;

            interface ExistingAnnotationLike {
              pageIndex?: number;
              type?: string;
              rectCoords?: unknown;
            }

            const isDuplicate = existingAnnotations.some(
              (ea: ExistingAnnotationLike) => {
                if (ea.pageIndex !== pageIndex || ea.type !== mappedType)
                  return false;
                const anchor = extractTopLeftAnchor(ea.rectCoords);
                if (!anchor) return false;
                // Chebyshev (L_infinity) distance: max(|x1 - x1'|, |y1 - y1'|) < 0.005
                return (
                  Math.max(
                    Math.abs(anchor.x1 - normX1),
                    Math.abs(anchor.y1 - normY1),
                  ) < 0.005
                );
              },
            );

            if (isDuplicate) continue;

            const colorHex = this.formatColor(annot.color, mappedType);
            const contentText = (
              annot.contents ||
              (typeof annot.contentsObj === 'object' && annot.contentsObj
                ? annot.contentsObj.str || ''
                : '') ||
              ''
            ).trim();

            const isTextMarkup =
              mappedType === AnnotationType.highlight ||
              mappedType === AnnotationType.underline ||
              mappedType === AnnotationType.strike;

            let extractedQuote = '';
            if (isTextMarkup) {
              const items = await loadTextItems();
              extractedQuote = this.extractUnderlyingText(
                items,
                normalizedRects,
                pageWidth,
                pageHeight,
              );
            }

            const quoteText = isTextMarkup
              ? extractedQuote ||
                (!contentText && mappedType === AnnotationType.highlight
                  ? 'Imported Highlight'
                  : '')
              : undefined;

            const comment = contentText;

            annotationsToCreate.push({
              type: mappedType,
              pageIndex,
              y: normY1,
              x: normX1,
              color: colorHex,
              quoteText,
              comment,
              rectCoords: normalizedRects,
              authorId: userId,
            });

            existingAnnotations.push({
              pageIndex,
              type: mappedType,
              rectCoords: normalizedRects,
            });

            imported++;
          }
        } catch (pageErr: unknown) {
          const message =
            pageErr instanceof Error ? pageErr.message : String(pageErr);
          this.logger.warn(
            `Failed extracting annotations from page ${p} of attachment ${attachmentId}: ${message}`,
          );
        } finally {
          try {
            page?.cleanup?.();
          } catch {
            // Ignore page cleanup errors
          }
        }
      }

      if (annotationsToCreate.length > 0) {
        await this.annotationsService.batchUpsertAnnotations(
          userId,
          attachmentId,
          {
            upserts: annotationsToCreate,
            deletes: [],
          },
          projectId,
        );
      }

      this.logger.log(
        `[PdfAnnotationImporter] Attachment ${attachmentId}: Scanned ${numPages} pages, found ${totalFound} external annotations, imported ${imported} new annotations.`,
      );

      return {
        imported,
        totalFound,
        pagesScanned: numPages,
      };
    } finally {
      await Promise.resolve(
        (
          documentProxy as { cleanup?: () => Promise<void> | void }
        )?.cleanup?.(),
      ).catch(() => {});
      await Promise.resolve(
        (
          documentProxy as { destroy?: () => Promise<void> | void }
        )?.destroy?.(),
      ).catch(() => {});
    }
  }

  protected async loadPdfDocument(data: Uint8Array) {
    return getDocumentProxy(data);
  }

  private parseNormalizedRects(
    quadPoints: unknown,
    rect: number[] | undefined,
    pageWidth: number,
    pageHeight: number,
  ): Array<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    width: number;
    height: number;
  }> {
    const toNormalizedRect = (
      rx1: number,
      ry1: number,
      rx2: number,
      ry2: number,
    ) => {
      const minX = Math.min(rx1, rx2);
      const maxX = Math.max(rx1, rx2);
      const minY = Math.min(ry1, ry2);
      const maxY = Math.max(ry1, ry2);

      const normX1 = Math.max(0, Math.min(1, minX / pageWidth));
      const normY1 = Math.max(0, Math.min(1, (pageHeight - maxY) / pageHeight));
      const normW = Math.min(1 - normX1, Math.max(0, (maxX - minX) / pageWidth));
      const normH = Math.min(
        1 - normY1,
        Math.max(0, (maxY - minY) / pageHeight),
      );
      if (normW <= 0.001 || normH <= 0.001) return null;
      return {
        x1: normX1,
        y1: normY1,
        x2: normX1 + normW,
        y2: normY1 + normH,
        width: normW,
        height: normH,
      };
    };

    const rects: Array<{
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      width: number;
      height: number;
    }> = [];

    if (
      quadPoints &&
      (Array.isArray(quadPoints) || ArrayBuffer.isView(quadPoints))
    ) {
      const nums = Array.from(quadPoints as ArrayLike<unknown>).map(Number);
      if (
        nums.length >= 8 &&
        nums.length % 8 === 0 &&
        nums.every((n) => Number.isFinite(n))
      ) {
        for (let i = 0; i <= nums.length - 8; i += 8) {
          const xs = [nums[i], nums[i + 2], nums[i + 4], nums[i + 6]];
          const ys = [nums[i + 1], nums[i + 3], nums[i + 5], nums[i + 7]];
          const normalized = toNormalizedRect(
            Math.min(...xs),
            Math.min(...ys),
            Math.max(...xs),
            Math.max(...ys),
          );
          if (normalized) {
            rects.push(normalized);
          }
        }
      }
    }

    if (rects.length > 0) {
      return rects;
    }

    if (rect && Array.isArray(rect) && rect.length >= 4) {
      const fallback = toNormalizedRect(rect[0], rect[1], rect[2], rect[3]);
      if (fallback) {
        return [fallback];
      }
    }

    return [];
  }

  private extractUnderlyingText(
    items: Array<{
      str?: string;
      transform?: number[];
      width?: number;
      height?: number;
      hasEOL?: boolean;
    }>,
    normalizedRects: Array<{
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      width: number;
      height: number;
    }>,
    pageWidth: number,
    pageHeight: number,
  ): string {
    if (!items || items.length === 0 || normalizedRects.length === 0) {
      return '';
    }

    const matchedChunks: string[] = [];

    for (const item of items) {
      const text = item.str;
      if (!text || !text.trim()) continue;

      const tr = item.transform;
      if (!Array.isArray(tr) || tr.length < 6) continue;

      const pdfX = Number(tr[4]) || 0;
      const pdfY = Number(tr[5]) || 0;
      const fontHeight =
        Math.abs(Number(item.height) || Number(tr[3]) || Number(tr[0]) || 10) ||
        10;
      const itemWidth = Math.max(
        1,
        Math.abs(Number(item.width) || text.length * (fontHeight * 0.5)),
      );

      const ix1 = Math.max(0, pdfX / pageWidth);
      const ix2 = Math.min(1, (pdfX + itemWidth) / pageWidth);
      const iy1 = Math.max(0, (pageHeight - (pdfY + fontHeight)) / pageHeight);
      const iy2 = Math.min(1, (pageHeight - pdfY + fontHeight * 0.25) / pageHeight);

      const intersects = normalizedRects.some((r) => {
        const overlapX = Math.min(ix2, r.x2) - Math.max(ix1, r.x1);
        const overlapY = Math.min(iy2, r.y2) - Math.max(iy1, r.y1);
        if (overlapX <= 0 || overlapY <= 0) return false;
        const itemHeightNorm = Math.max(0.001, iy2 - iy1);
        return overlapY >= itemHeightNorm * 0.25;
      });

      if (intersects) {
        matchedChunks.push(text.trim());
      }
    }

    return matchedChunks.join(' ').replace(/\s+/g, ' ').trim();
  }

  private mapSubtype(subtype?: string): AnnotationType | null {
    return this.normalizer.parseType(subtype, null);
  }

  private formatColor(colorArr?: number[], type?: AnnotationType): string {
    if (!colorArr || !Array.isArray(colorArr) || colorArr.length < 3) {
      if (type === AnnotationType.strike) return '#ff6666';
      if (type === AnnotationType.underline) return '#2ea8e5';
      if (type === AnnotationType.rect) return '#5fb236';
      return '#ffd400';
    }

    const hasFloat = colorArr.some((c) => c > 0 && c <= 1);
    const r = Math.round(
      hasFloat && colorArr[0] <= 1 ? colorArr[0] * 255 : colorArr[0],
    );
    const g = Math.round(
      hasFloat && colorArr[1] <= 1 ? colorArr[1] * 255 : colorArr[1],
    );
    const b = Math.round(
      hasFloat && colorArr[2] <= 1 ? colorArr[2] * 255 : colorArr[2],
    );

    const hex = (val: number) =>
      Math.max(0, Math.min(255, val)).toString(16).padStart(2, '0');

    return `#${hex(r)}${hex(g)}${hex(b)}`;
  }
}
