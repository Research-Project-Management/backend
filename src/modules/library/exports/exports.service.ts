import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  Optional,
  Inject,
} from '@nestjs/common';
import { PrismaService } from '../../../core/database/prisma.service';
import { resolveTenantWorkspaceId } from '../../../core/utils/tenant.util';
import { CitationService } from '../citation/citation.service';
import { CslJsonMapper } from '../citation/mappers/csl-json.mapper';
import { ExportLibraryDto, ExportFormatType } from './dto/exports.dto';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { ITEM_READ_PORT, IItemReadPort } from '../items/ports/items.ports';

import { ItemsService } from '../items/items.service';
import { AnnotationsService } from '../annotations/annotations.service';
import { PdfBakerService } from './services/pdf-baker.service';
import { ExportResult, BurnableAnnotation } from './types/exports.types';
import { formatCsvExport } from './utils/exports.utils';

export { BurnableAnnotation, ExportResult };

/** Maximum number of items exported in a single request. */
const EXPORT_MAX_ITEMS = 1000;
/** Cursor-page size used when fetching from the DB. */
const EXPORT_CHUNK_SIZE = 200;

@Injectable()
export class ExportsService {
  private readonly logger = new Logger(ExportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly citationService: CitationService,
    @Optional()
    @Inject(ITEM_READ_PORT)
    private readonly itemReadPort?: IItemReadPort,
    @Optional()
    @Inject(ItemsService)
    private readonly itemsService?: ItemsService,
    @Optional()
    private readonly annotationsService?: AnnotationsService,
    @Optional()
    private readonly pdfBakerService: PdfBakerService = new PdfBakerService(),
  ) {}

  private resolveWorkspaceId(workspaceId: string): Promise<string> {
    return resolveTenantWorkspaceId(this.prisma, workspaceId);
  }

  /**
   * Fetches items in cursor-based chunks to avoid loading the entire library
   * into Node.js RAM in a single query.
   *
   * @param where  Prisma `CatalogItem` where clause.
   * @param maxItems  Hard cap on total items returned (default: EXPORT_MAX_ITEMS).
   * @returns `{ items, truncated }` — `truncated` is true when the library
   *          contained more rows than `maxItems`.
   */
  private async fetchItemsInChunks(
    where: any,
    maxItems: number = EXPORT_MAX_ITEMS,
  ): Promise<{ items: any[]; truncated: boolean }> {
    const collected: any[] = [];
    let cursor: string | undefined;
    let truncated = false;

    while (collected.length < maxItems) {
      const remaining = maxItems - collected.length;
      const pageSize = Math.min(EXPORT_CHUNK_SIZE, remaining);
      const take = pageSize + 1; // +1 sentinel to detect if DB has more rows than this page

      const chunk = await this.prisma.catalogItem.findMany({
        where,
        include: {
          contributors: { orderBy: { orderIndex: 'asc' } },
        },
        orderBy: { createdAt: 'desc' },
        take,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });

      // hasMore: DB returned more rows than the page we requested → still more data in DB
      const hasMore = chunk.length > pageSize;
      if (hasMore) {
        chunk.pop(); // discard the sentinel overflow row
      }

      collected.push(...chunk);

      if (chunk.length === 0) break;

      // truncated: we just consumed the last available slot (remaining === pageSize)
      // and the DB still has more rows beyond this page → cap was hit
      if (hasMore && remaining <= EXPORT_CHUNK_SIZE) {
        truncated = true;
        break;
      }

      if (!hasMore) break; // no more rows in DB

      cursor = chunk[chunk.length - 1].id;
    }

    return { items: collected, truncated };
  }

  async exportLibrary(
    rawWorkspaceId: string,
    dto: ExportLibraryDto,
  ): Promise<ExportResult> {
    const workspaceId = await this.resolveWorkspaceId(rawWorkspaceId);

    const where = {
      workspaceId,
      deletedAt: null,
      ...(dto.itemIds && dto.itemIds.length > 0
        ? { id: { in: dto.itemIds } }
        : {}),
      ...(dto.collectionId
        ? { collectionItems: { some: { collectionId: dto.collectionId } } }
        : {}),
      ...(dto.tagId ? { itemTags: { some: { tagId: dto.tagId } } } : {}),
    };

    // When the caller specifies explicit itemIds, fetch them directly (already scoped).
    // Otherwise use cursor-based chunking to avoid OOM on large libraries.
    let items: any[];
    let truncated: boolean;

    if (dto.itemIds && dto.itemIds.length > 0) {
      items = this.itemReadPort
        ? await this.itemReadPort.findByIds(workspaceId, dto.itemIds)
        : await this.prisma.catalogItem.findMany({
            where,
            include: { contributors: { orderBy: { orderIndex: 'asc' } } },
            orderBy: { createdAt: 'desc' },
          });
      truncated = false;
    } else {
      ({ items, truncated } = await this.fetchItemsInChunks(where));
      if (truncated) {
        this.logger.warn(
          `exportLibrary: workspace=${workspaceId} has >${EXPORT_MAX_ITEMS} items; export truncated to ${EXPORT_MAX_ITEMS}.`,
        );
      }
    }

    const timestamp = new Date().toISOString().split('T')[0];

    switch (dto.format) {
      case 'bibtex': {
        const entries = items.map((it) => {
          const authors = CslJsonMapper.getAuthorNames(it);
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
          truncated,
        };
      }

      case 'ris': {
        const entries = items.map((it) => {
          const authors = CslJsonMapper.getAuthorNames(it);
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
          truncated,
        };
      }

      case 'csl-json': {
        const cslList = items.map((it) => CslJsonMapper.toCsl(it));

        return {
          format: 'csl-json',
          filename: `library-export-${timestamp}.json`,
          mimeType: 'application/json',
          content: JSON.stringify(cslList, null, 2),
          itemCount: items.length,
          truncated,
        };
      }

      case 'csv': {
        const csvItems = items.map((it) => ({
          id: it.id,
          title: it.title,
          authors: CslJsonMapper.getAuthorNames(it),
          year: it.year,
          publicationTitle: it.publicationTitle,
          doi: it.doi,
          itemType: it.itemType,
        }));

        return {
          format: 'csv',
          filename: `library-export-${timestamp}.csv`,
          mimeType: 'text/csv',
          content: formatCsvExport(csvItems),
          itemCount: items.length,
          truncated,
        };
      }

      case 'markdown': {
        const mdLines = [`# Library Export (${timestamp})\n`];
        items.forEach((it, idx) => {
          const auth =
            CslJsonMapper.getAuthorNames(it).join(', ') || 'Unknown Authors';
          const yr = it.year ? ` (${it.year})` : '';
          mdLines.push(`${idx + 1}. **${it.title}** — *${auth}*${yr}`);
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
          truncated,
        };
      }

      default:
        throw new BadRequestException(
          `Unsupported export format: ${(dto as { format: string }).format}`,
        );
    }
  }

  async exportBundle(rawWorkspaceId: string, collectionId: string) {
    const workspaceId = await this.resolveWorkspaceId(rawWorkspaceId);
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
      take: 2000,
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
      for (const att of it.attachments || []) {
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
    return this.pdfBakerService.burnAnnotationsToPdf(rawPdfBuffer, annotations);
  }

  /**
   * Exports an annotated PDF for a specific CatalogItem.
   */
  async exportAnnotatedItemPdf(
    rawWorkspaceId: string,
    itemId: string,
    rawPdfBuffer?: Buffer,
  ): Promise<{ filename: string; buffer: Uint8Array }> {
    const workspaceId = await this.resolveWorkspaceId(rawWorkspaceId);
    const item: any = this.itemReadPort
      ? await this.itemReadPort.findById(workspaceId, itemId)
      : await this.prisma.catalogItem.findFirst({
          where: { id: itemId, workspaceId, deletedAt: null },
          include: {
            attachments: true,
          },
        });

    if (!item) {
      throw new NotFoundException('Catalog item not found');
    }

    const pdfAttachment = Array.isArray(item.attachments)
      ? item.attachments.find((a: any) => a.mimeType === 'application/pdf') ||
        item.attachments[0]
      : undefined;

    if (!pdfAttachment && !rawPdfBuffer) {
      throw new NotFoundException('No PDF attachment found for this item');
    }

    const annotations =
      this.annotationsService && pdfAttachment?.id
        ? await this.annotationsService.getAnnotationsByAttachment(
            workspaceId,
            pdfAttachment.id,
          )
        : await this.prisma.annotation.findMany({
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

  /**
   * Export BibTeX bibliography strictly for a specific list of citation keys.
   * Used for on-demand BibTeX sync and automatic \bibliography injection during LaTeX compilation.
   */
  async exportByCitationKeys(
    rawWorkspaceId: string,
    keys: string[],
  ): Promise<{
    content: string;
    count: number;
    foundKeys: string[];
    missingKeys: string[];
  }> {
    if (!keys || keys.length === 0) {
      return { content: '', count: 0, foundKeys: [], missingKeys: [] };
    }

    const workspaceId = await this.resolveWorkspaceId(rawWorkspaceId);
    const normalizedKeys = keys
      .map((k) => k.trim().toLowerCase())
      .filter(Boolean);

    const items = await this.prisma.catalogItem.findMany({
      where: {
        workspaceId,
        deletedAt: null,
      },
      include: {
        contributors: { orderBy: { orderIndex: 'asc' } },
      },
    });

    const keySet = new Set(normalizedKeys);
    const matchedItems = items.filter((it) => {
      const citeKey = (it.citationKey || '').toLowerCase();
      return keySet.has(citeKey);
    });

    const foundKeys = matchedItems.map((it) => it.citationKey || it.id);
    const foundKeySet = new Set(foundKeys.map((k) => k.toLowerCase()));
    const missingKeys = keys.filter((k) => !foundKeySet.has(k.toLowerCase()));

    const entries = matchedItems.map((it) => {
      const authors = CslJsonMapper.getAuthorNames(it);
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
      content: entries.join('\n\n'),
      count: matchedItems.length,
      foundKeys,
      missingKeys,
    };
  }
}

export const PdfExportService = ExportsService;
export type PdfExportService = ExportsService;
