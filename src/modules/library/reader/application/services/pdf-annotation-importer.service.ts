import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  Inject,
  Optional,
} from '@nestjs/common';
import { AnnotationsRepository } from '../../infrastructure/repositories/annotations.repository';
import { AttachmentsRepository } from '../../infrastructure/repositories/attachments.repository';
import { STORAGE_PORT, IStoragePort } from '@/modules/storage/storage.port';
import { AnnotationsService } from './annotations.service';
import { AttachmentsService } from './attachments.service';
import { AnnotationType } from '../../domain/types/annotations.types';
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
    @Optional() private readonly attachmentsService?: AttachmentsService,
  ) {}

  /**
   * Import annotations directly from the PDF file attached to attachmentId.
   * Reads standard PDF /Annots dictionaries (Highlight, Underline, StrikeOut, FreeText, Square)
   * and persists them as non-destructive W3C-compliant annotations in Flux.
   */
  async importFromAttachment(
    userId: string,
    attachmentId: string,
  ): Promise<ImportAnnotationsResult> {
    if (this.attachmentsService) {
      await this.attachmentsService.assertAttachmentExists(
        attachmentId,
        userId,
      );
    }

    const attachment = await this.attachmentsRepo.findUnique(attachmentId, {
      item: true,
    });

    if (!attachment || attachment.deletedAt) {
      throw new NotFoundException(`Attachment ${attachmentId} not found`);
    }

    if (attachment.item) {
      if (attachment.item.projectId) {
        if (attachment.item.userId !== userId) {
          const isMember = await this.attachmentsRepo.checkProjectMember(
            attachment.item.projectId,
            userId,
          );
          if (!isMember) {
            throw new NotFoundException(`Attachment ${attachmentId} not found`);
          }
        }
      } else if (attachment.item.userId && attachment.item.userId !== userId) {
        throw new NotFoundException(`Attachment ${attachmentId} not found`);
      }
    }

    // Resolve fileId for storage reading
    const fileId =
      attachment.fileId ||
      attachment.url?.match(
        /\/api\/(?:v1\/(?:projects\/[^/]+\/)?library\/)?(?:attachments\/)?files\/([a-zA-Z0-9_-]+)/,
      )?.[1];

    if (!fileId) {
      throw new BadRequestException(
        `Cannot locate stored PDF binary for attachment ${attachmentId}`,
      );
    }

    // Read binary buffer from Storage Port
    const storageFile = await this.storagePort.readOwnedFile({ fileId });
    const buffer = storageFile.buffer;

    if (!buffer || buffer.byteLength === 0) {
      throw new BadRequestException(
        `Empty or corrupted PDF payload for attachment ${attachmentId}`,
      );
    }

    // Clone binary buffer into independent Uint8Array to prevent buffer detachment
    const clonedData = new Uint8Array(buffer.byteLength);
    clonedData.set(buffer);

    let documentProxy: any;
    try {
      documentProxy = await getDocumentProxy(clonedData);
    } catch (err: any) {
      this.logger.error(
        `Failed to parse PDF document proxy for attachment ${attachmentId}: ${err?.message}`,
      );
      throw new BadRequestException(
        `Failed to parse PDF structure: ${err?.message || 'Invalid PDF'}`,
      );
    }

    const numPages = documentProxy.numPages || 0;
    if (numPages === 0) {
      return { imported: 0, totalFound: 0, pagesScanned: 0 };
    }

    // Load existing annotations to avoid duplicate imports
    const existingAnnotations =
      await this.annotationsRepo.findExistingForImport(attachmentId);

    let totalFound = 0;
    let imported = 0;

    for (let p = 1; p <= numPages; p++) {
      try {
        const page = await documentProxy.getPage(p);
        const annots = await page.getAnnotations();
        if (!annots || !Array.isArray(annots) || annots.length === 0) {
          continue;
        }

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
          if (!mappedType) continue; // Ignore links, widgets, form fields

          totalFound++;

          // Parse rect coordinates (PDF bottom-left to standard top-left normalized 0..1)
          const rect = annot.rect;
          if (!rect || !Array.isArray(rect) || rect.length < 4) continue;

          const rx1 = Math.min(rect[0], rect[2]);
          const rx2 = Math.max(rect[0], rect[2]);
          const ry1 = Math.min(rect[1], rect[3]);
          const ry2 = Math.max(rect[1], rect[3]);

          const normX1 = Math.max(0, rx1 / pageWidth);
          const normY1 = Math.max(0, (pageHeight - ry2) / pageHeight);
          const normW = Math.min(1 - normX1, (rx2 - rx1) / pageWidth);
          const normH = Math.min(1 - normY1, (ry2 - ry1) / pageHeight);

          if (normW <= 0.001 || normH <= 0.001) continue;

          const normalizedRect = {
            x1: normX1,
            y1: normY1,
            x2: normX1 + normW,
            y2: normY1 + normH,
            width: normW,
            height: normH,
          };

          // Check if duplicate exists on this page
          const isDuplicate = existingAnnotations.some((ea) => {
            if (ea.pageIndex !== pageIndex || ea.type !== mappedType)
              return false;
            const eaRects = Array.isArray(ea.rectCoords)
              ? (ea.rectCoords as any[])
              : [];
            if (eaRects.length === 0) return false;
            const first = eaRects[0];
            return (
              Math.abs((first?.x1 ?? 0) - normX1) < 0.02 &&
              Math.abs((first?.y1 ?? 0) - normY1) < 0.02
            );
          });

          if (isDuplicate) continue;

          const colorHex = this.formatColor(annot.color, mappedType);
          const contentText =
            annot.contents ||
            (typeof annot.contentsObj === 'object'
              ? annot.contentsObj?.str
              : '') ||
            '';

          await this.annotationsService.createAnnotation(userId, {
            attachmentId,
            type: mappedType,
            pageIndex,
            y: normY1,
            x: normX1,
            color: colorHex,
            quoteText:
              contentText ||
              (mappedType === AnnotationType.highlight
                ? 'Imported Highlight'
                : undefined),
            comment:
              contentText && mappedType !== AnnotationType.highlight
                ? contentText
                : '',
            rectCoords: [normalizedRect],
            authorId: userId,
          });

          // Track in local set to prevent within-file duplicates
          existingAnnotations.push({
            pageIndex,
            type: mappedType,
            rectCoords: [normalizedRect],
          });

          imported++;
        }
      } catch (pageErr: any) {
        this.logger.warn(
          `Failed extracting annotations from page ${p} of attachment ${attachmentId}: ${pageErr?.message}`,
        );
      }
    }

    this.logger.log(
      `[PdfAnnotationImporter] Attachment ${attachmentId}: Scanned ${numPages} pages, found ${totalFound} external annotations, imported ${imported} new annotations.`,
    );

    return {
      imported,
      totalFound,
      pagesScanned: numPages,
    };
  }

  private mapSubtype(subtype?: string): AnnotationType | null {
    if (!subtype) return null;
    switch (subtype.toLowerCase()) {
      case 'highlight':
        return AnnotationType.highlight;
      case 'underline':
        return AnnotationType.underline;
      case 'strikeout':
      case 'strike':
        return AnnotationType.strike;
      case 'freetext':
      case 'text':
        return AnnotationType.text;
      case 'square':
      case 'circle':
      case 'ink':
      case 'line':
        return AnnotationType.rect;
      default:
        return null;
    }
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
