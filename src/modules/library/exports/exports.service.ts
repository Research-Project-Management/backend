import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../../../core/database/prisma.service';
import { CitationService } from '../citation/citation.service';
import { ExportLibraryDto, ExportFormatType } from './dto/export.dto';
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

export interface ExportResult {
  format: ExportFormatType;
  filename: string;
  mimeType: string;
  content: string;
  itemCount: number;
}

@Injectable()
export class ExportsService {
  private readonly logger = new Logger(ExportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly citationService: CitationService,
  ) {}

  async exportLibrary(
    workspaceId: string,
    dto: ExportLibraryDto,
  ): Promise<ExportResult> {
    const items = await this.prisma.catalogItem.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        ...(dto.itemIds && dto.itemIds.length > 0
          ? { id: { in: dto.itemIds } }
          : {}),
        ...(dto.collectionId
          ? { collectionItems: { some: { collectionId: dto.collectionId } } }
          : {}),
        ...(dto.tagId ? { itemTags: { some: { tagId: dto.tagId } } } : {}),
      },
      include: {
        contributors: { orderBy: { orderIndex: 'asc' } },
      },
      orderBy: { createdAt: 'desc' },
      take: 5000,
    });

    // Helper: derive author name list from contributors
    const getAuthorNames = (item: (typeof items)[0]) =>
      item.contributors
        .filter((c) => c.creatorType === 'author')
        .map(
          (c) =>
            c.fullName || `${c.firstName || ''} ${c.lastName || ''}`.trim(),
        );

    const timestamp = new Date().toISOString().split('T')[0];

    switch (dto.format) {
      case 'bibtex': {
        const entries = items.map((it) => {
          const authors = getAuthorNames(it);
          const res = this.citationService.formatItem(
            {
              id: it.id,
              itemType: it.itemType ?? 'journalArticle',
              title: it.title,
              authors,
              publicationTitle: it.publicationTitle ?? undefined,
              year: it.year ?? undefined,
              volume: it.volume ?? undefined,
              pages: it.pages ?? undefined,
              doi: it.doi ?? undefined,
              url: it.url ?? undefined,
              citationKey: it.citationKey ?? undefined,
            },
            'bibtex',
          );
          return res.bibliography;
        });

        return {
          format: 'bibtex',
          filename: `library-export-${timestamp}.bib`,
          mimeType: 'application/x-bibtex',
          content: entries.join('\n\n'),
          itemCount: items.length,
        };
      }

      case 'ris': {
        const entries = items.map((it) => {
          const authors = getAuthorNames(it);
          const res = this.citationService.formatItem(
            {
              id: it.id,
              itemType: it.itemType ?? 'journalArticle',
              title: it.title,
              authors,
              publicationTitle: it.publicationTitle ?? undefined,
              year: it.year ?? undefined,
              volume: it.volume ?? undefined,
              pages: it.pages ?? undefined,
              doi: it.doi ?? undefined,
              url: it.url ?? undefined,
            },
            'ris',
          );
          return res.bibliography;
        });

        return {
          format: 'ris',
          filename: `library-export-${timestamp}.ris`,
          mimeType: 'application/x-research-info-systems',
          content: entries.join('\n'),
          itemCount: items.length,
        };
      }

      case 'csl-json': {
        const cslList = items.map((it) => ({
          id: it.citationKey || it.id,
          type:
            it.itemType === 'conferencePaper'
              ? 'paper-conference'
              : 'article-journal',
          title: it.title,
          author: getAuthorNames(it).map((a) => {
            const parts = a.trim().split(/\s+/);
            const family = parts.pop() || '';
            const given = parts.join(' ');
            return { given, family };
          }),
          issued: it.year ? { 'date-parts': [[it.year]] } : undefined,
          'container-title': it.publicationTitle ?? undefined,
          volume: it.volume ?? undefined,
          page: it.pages ?? undefined,
          DOI: it.doi ?? undefined,
          URL: it.url ?? undefined,
        }));

        return {
          format: 'csl-json',
          filename: `library-export-${timestamp}.json`,
          mimeType: 'application/json',
          content: JSON.stringify(cslList, null, 2),
          itemCount: items.length,
        };
      }

      case 'csv': {
        const headers = [
          'id',
          'title',
          'authors',
          'year',
          'publicationTitle',
          'doi',
          'itemType',
        ];
        const rows = items.map((it) => [
          `"${it.id}"`,
          `"${(it.title || '').replace(/"/g, '""')}"`,
          `"${getAuthorNames(it).join('; ').replace(/"/g, '""')}"`,
          it.year || '',
          `"${(it.publicationTitle || '').replace(/"/g, '""')}"`,
          `"${it.doi || ''}"`,
          `"${it.itemType || ''}"`,
        ]);

        const csvContent = [
          headers.join(','),
          ...rows.map((r) => r.join(',')),
        ].join('\n');

        return {
          format: 'csv',
          filename: `library-export-${timestamp}.csv`,
          mimeType: 'text/csv',
          content: csvContent,
          itemCount: items.length,
        };
      }

      case 'markdown': {
        const mdLines = [`# Library Export (${timestamp})\n`];
        items.forEach((it, idx) => {
          const auth = getAuthorNames(it).join(', ') || 'Unknown Authors';
          const yr = it.year ? ` (${it.year})` : '';
          mdLines.push(`${idx + 1}. **${it.title}** â€” *${auth}*${yr}`);
          if (it.publicationTitle)
            mdLines.push(`   *Published in:* ${it.publicationTitle}`);
          if (it.doi)
            mdLines.push(`   *DOI:* [${it.doi}](https://doi.org/${it.doi})`);
          mdLines.push('');
        });

        return {
          format: 'markdown',
          filename: `library-export-${timestamp}.md`,
          mimeType: 'text/markdown',
          content: mdLines.join('\n'),
          itemCount: items.length,
        };
      }

      default:
        throw new BadRequestException(
          `Unsupported export format: ${(dto as { format: string }).format}`,
        );
    }
  }

  async exportBundle(workspaceId: string, collectionId: string) {
    const collection = await this.prisma.collection.findFirst({
      where: { id: collectionId, workspaceId, deletedAt: null },
    });

    if (!collection) {
      throw new BadRequestException(`Collection ${collectionId} not found`);
    }

    const items = await this.prisma.catalogItem.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        collectionItems: { some: { collectionId } },
      },
      include: {
        attachments: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    const bibtexRes = await this.exportLibrary(workspaceId, {
      format: 'bibtex',
      collectionId,
    });

    const files: Array<{
      itemId: string;
      title: string;
      filename: string;
      fileUrl: string;
    }> = [];
    for (const it of items) {
      for (const att of it.attachments) {
        files.push({
          itemId: it.id,
          title: it.title,
          filename: att.filename,
          fileUrl: att.url,
        });
      }
    }

    return {
      collection: { id: collection.id, name: collection.name },
      totalItems: items.length,
      totalFiles: files.length,
      bibtex: bibtexRes.content,
      files,
    };
  }

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

export const PdfExportService = ExportsService;
export type PdfExportService = ExportsService;
