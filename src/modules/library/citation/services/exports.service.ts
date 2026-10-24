import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  Optional,
  Inject,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ExportsRepository,
  EXPORT_MAX_ITEMS,
  ExportItemRecord,
} from '@/modules/library/citation/repositories/exports.repository';
import { CitationService } from './citation.service';
import { CslJsonMapper } from '@/modules/library/citation/domain/csl-json.mapper';
import { ExportLibraryDto } from '@/modules/library/citation/dto/exports.dto';
import { PdfBakerService } from './pdf-baker.service';
import {
  ExportResult,
  BurnableAnnotation,
} from '@/modules/library/citation/types/exports.types';
import { CitationItemInput } from '@/modules/library/citation/types/citation.types';
import { formatCsvExport } from '@/modules/library/citation/domain/exports.domain';
import { STORAGE_PORT, IStoragePort } from '@/modules/storage/storage.port';
import {
  extractItemCitationAliases,
  resolveEmittedCitationEntries,
} from '@/modules/library/citation/domain/citation-key-resolver.domain';
import { normalizeProjectScopeId } from '@/modules/library/core';

export type { BurnableAnnotation, ExportResult };
export { extractItemCitationAliases };

@Injectable()
export class ExportsService {
  private readonly logger = new Logger(ExportsService.name);

  constructor(
    private readonly exportsRepo: ExportsRepository,
    private readonly citationService: CitationService,
    private readonly pdfBakerService: PdfBakerService,
    @Optional()
    @Inject(STORAGE_PORT)
    private readonly storagePort?: IStoragePort,
  ) {}

  async exportLibrary(
    userId: string,
    dto: ExportLibraryDto,
  ): Promise<ExportResult> {
    let scopeWhere: Prisma.ItemWhereInput = {
      userId,
      projectId: null,
      deletedAt: null,
    };

    const effectiveProjectId = normalizeProjectScopeId(dto.projectId);
    if (effectiveProjectId) {
      const member = await this.exportsRepo.findProjectMember(
        effectiveProjectId,
        userId,
      );
      if (!member) {
        throw new NotFoundException(
          `Project ${effectiveProjectId} not found or access denied`,
        );
      }
      scopeWhere = { projectId: effectiveProjectId, deletedAt: null };
    } else if (dto.collectionId) {
      const collection = await this.exportsRepo.findCollection(
        dto.collectionId,
      );
      if (collection?.projectId) {
        const member = await this.exportsRepo.findProjectMember(
          collection.projectId,
          userId,
        );
        if (!member) {
          throw new NotFoundException(
            `Collection ${dto.collectionId} not found or access denied`,
          );
        }
        scopeWhere = { projectId: collection.projectId, deletedAt: null };
      } else if (
        collection &&
        'userId' in collection &&
        collection.userId &&
        collection.userId !== userId
      ) {
        throw new NotFoundException(
          `Collection ${dto.collectionId} not found or access denied`,
        );
      }
    }

    const where = {
      ...scopeWhere,
      ...(dto.itemIds && dto.itemIds.length > 0
        ? { id: { in: dto.itemIds } }
        : {}),
      ...(dto.collectionId
        ? { collectionItems: { some: { collectionId: dto.collectionId } } }
        : {}),
      ...(dto.tagId ? { itemTags: { some: { tagId: dto.tagId } } } : {}),
    };

    let items: ExportItemRecord[];
    let truncated: boolean;

    if (dto.itemIds && dto.itemIds.length > 0) {
      const take = Math.min(dto.limit || 2000, 2000);
      items = await this.exportsRepo.findItems(where, take);
      truncated = false;
    } else {
      ({ items, truncated } = await this.exportsRepo.fetchItemsInChunks(where));
      if (truncated) {
        this.logger.warn(
          `exportLibrary: userId=${userId} has >${EXPORT_MAX_ITEMS} items; export truncated to ${EXPORT_MAX_ITEMS}.`,
        );
      }
    }

    const timestamp = new Date().toISOString().split('T')[0];

    switch (dto.format) {
      case 'bibtex': {
        return {
          format: 'bibtex',
          filename: `library-export-${timestamp}.bib`,
          mimeType: 'application/x-bibtex',
          content: this.formatItemsAsBibtex(items),
          itemCount: items.length,
          truncated,
        };
      }

      case 'ris': {
        const entries = items.map((it) => {
          const res = this.citationService.formatItem(
            this.toCitationItemInput(it),
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
        const csvItems = items.map((it) => {
          const csl = CslJsonMapper.toCsl(it);
          return {
            id: it.id,
            title: it.title,
            authors: CslJsonMapper.getAuthorNames(it),
            year: it.year,
            publicationTitle: it.publicationTitle,
            publisher: csl.publisher || undefined,
            doi: it.doi || csl.DOI || null,
            itemType: it.itemType,
            citationKey:
              it.citationKey ||
              (typeof csl['citation-key'] === 'string'
                ? csl['citation-key']
                : null),
            url: it.url,
          };
        });

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

  private toCitationItemInput(
    it: ExportItemRecord,
    overrideKey?: string,
  ): CitationItemInput {
    const csl = CslJsonMapper.toCsl(it);
    const effectiveKey =
      overrideKey ||
      it.citationKey ||
      (typeof csl['citation-key'] === 'string'
        ? csl['citation-key']
        : undefined);
    return {
      ...(it as unknown as Record<string, unknown>),
      id: effectiveKey || it.id,
      itemType: it.itemType ?? 'journalArticle',
      title: it.title,
      authors: CslJsonMapper.getAuthorNames(it),
      publicationTitle: it.publicationTitle ?? csl['container-title'],
      publisher: csl.publisher,
      year: it.year ?? undefined,
      volume: csl.volume !== undefined ? String(csl.volume) : undefined,
      issue: csl.issue !== undefined ? String(csl.issue) : undefined,
      pages: csl.page,
      doi: it.doi || csl.DOI || undefined,
      isbn: csl.ISBN || undefined,
      issn: csl.ISSN || undefined,
      pmid: csl.PMID || undefined,
      pmcid: csl.PMCID || undefined,
      arxivId: typeof csl._arxivId === 'string' ? csl._arxivId : undefined,
      edition: csl.edition !== undefined ? String(csl.edition) : undefined,
      place: csl['publisher-place'] || undefined,
      series: csl['collection-title'] || undefined,
      url: it.url ?? csl.URL ?? undefined,
      abstract: it.abstract ?? csl.abstract ?? undefined,
      citationKey: effectiveKey,
      contributors: it.contributors,
      creators: it.contributors,
      metadata: it.metadata,
      updatedAt: it.updatedAt ?? undefined,
      version: it.version ?? undefined,
    };
  }

  private formatItemsAsBibtex(items: ExportItemRecord[]): string {
    const entries = items.map((it) => {
      const res = this.citationService.formatItem(
        this.toCitationItemInput(it),
        'bibtex',
      );
      return res.bibliography;
    });
    return entries.join('\n\n');
  }

  async exportBundle(
    userId: string,
    collectionId: string,
    projectId?: string,
  ) {
    const collection = await this.exportsRepo.findCollection(collectionId);

    if (!collection) {
      throw new BadRequestException(`Collection ${collectionId} not found`);
    }

    const normalizedProjectId = normalizeProjectScopeId(projectId);
    const effectiveProjectId = collection.projectId || normalizedProjectId;

    let scopeWhere: Prisma.ItemWhereInput = {
      userId,
      projectId: null,
      deletedAt: null,
    };
    if (effectiveProjectId) {
      if (
        collection.projectId &&
        normalizedProjectId &&
        collection.projectId !== normalizedProjectId
      ) {
        throw new BadRequestException(`Collection ${collectionId} not found`);
      }
      const member = await this.exportsRepo.findProjectMember(
        effectiveProjectId,
        userId,
      );
      if (!member) {
        throw new BadRequestException(
          `Collection ${collectionId} not found or access denied`,
        );
      }
      scopeWhere = { projectId: effectiveProjectId, deletedAt: null };
    } else if (collection.userId !== userId) {
      throw new BadRequestException(`Collection ${collectionId} not found`);
    }

    const items = await this.exportsRepo.findItems(
      {
        ...scopeWhere,
        collectionItems: { some: { collectionId } },
      },
      2000,
    );

    const bibtexContent = this.formatItemsAsBibtex(items);

    const files: Array<{
      itemId: string;
      title: string;
      filename: string;
      fileUrl: string;
    }> = [];
    for (const it of items) {
      const attachments = Array.isArray(it.attachments) ? it.attachments : [];
      for (const att of attachments) {
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
      bibtex: bibtexContent,
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
   * Exports an annotated PDF for a specific Item.
   */
  async exportAnnotatedItemPdf(
    userId: string,
    itemId: string,
    rawPdfBuffer?: Buffer,
    projectId?: string,
  ): Promise<{
    filename: string;
    mimeType: string;
    buffer: Buffer;
    base64: string;
  }> {
    const effectiveProjectId = normalizeProjectScopeId(projectId);
    const item = await this.exportsRepo.findItemById(
      userId,
      itemId,
      effectiveProjectId,
    );

    if (!item) {
      throw new NotFoundException('Item not found');
    }

    const attachments = item.attachments ?? [];

    const pdfAttachment =
      attachments.find((a) => a.mimeType === 'application/pdf') ||
      attachments[0];

    if (!pdfAttachment && !rawPdfBuffer) {
      throw new NotFoundException('No PDF attachment found for this item');
    }

    const annotations: BurnableAnnotation[] = Array.isArray(
      pdfAttachment?.annotations,
    )
      ? (pdfAttachment.annotations as unknown as BurnableAnnotation[])
      : [];

    let bufferToUse = rawPdfBuffer;
    if (!bufferToUse && pdfAttachment?.fileId && this.storagePort) {
      try {
        const fileOutput = await this.storagePort.readOwnedFile({
          fileId: pdfAttachment.fileId,
          userId,
          projectId: effectiveProjectId,
        });
        if (fileOutput?.buffer) {
          bufferToUse = fileOutput.buffer;
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Could not read PDF attachment ${pdfAttachment.fileId} from storage: ${message}`,
        );
      }
    }

    if (!bufferToUse) {
      throw new NotFoundException(
        `Source PDF file content for attachment ${pdfAttachment?.id || 'unknown'} not found in storage`,
      );
    }

    const burned = await this.burnAnnotationsToPdf(bufferToUse, annotations);

    const safeFilename = `${item.title.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60)}_annotated.pdf`;

    const burnedBuffer = Buffer.isBuffer(burned) ? burned : Buffer.from(burned);

    return {
      filename: safeFilename,
      mimeType: 'application/pdf',
      buffer: burnedBuffer,
      base64: burnedBuffer.toString('base64'),
    };
  }

  /**
   * Export BibTeX bibliography strictly for a specific list of citation keys.
   * Used for on-demand BibTeX sync and automatic \bibliography injection during LaTeX compilation.
   * Supports primary citationKey, item UUID, and merged/alias citation keys (mergedCitationKeys / tex.ids).
   */
  async exportByCitationKeys(
    userId: string,
    keys: string[],
    projectId?: string,
  ): Promise<{
    content: string;
    count: number;
    foundKeys: string[];
    missingKeys: string[];
  }> {
    if (!keys || keys.length === 0) {
      return { content: '', count: 0, foundKeys: [], missingKeys: [] };
    }

    const trimmedKeys = keys.map((k) => k.trim()).filter(Boolean);
    const normalizedKeys = trimmedKeys.map((k) => k.toLowerCase());

    const effectiveProjectId = normalizeProjectScopeId(projectId);

    if (effectiveProjectId && userId) {
      const member = await this.exportsRepo.findProjectMember(
        effectiveProjectId,
        userId,
      );
      if (!member) {
        throw new NotFoundException(
          `Project ${effectiveProjectId} not found or access denied`,
        );
      }
    }

    const scopeWhere: Prisma.ItemWhereInput = effectiveProjectId
      ? { projectId: effectiveProjectId, deletedAt: null }
      : { userId, projectId: null, deletedAt: null };

    const isUuid = (val: string) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-7][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        val,
      );
    const idKeys = normalizedKeys.filter((k) => isUuid(k));
    const citeKeys = normalizedKeys;

    const targetedScopeWhere: Prisma.ItemWhereInput = {
      AND: [
        scopeWhere,
        {
          OR: [
            { citationKey: { in: citeKeys, mode: 'insensitive' } },
            ...(idKeys.length > 0 ? [{ id: { in: idKeys } }] : []),
          ],
        },
      ],
    };

    const initialItems =
      await this.exportsRepo.findItemsByScope(targetedScopeWhere);
    const itemById = new Map<string, ExportItemRecord>();
    for (const it of initialItems) {
      if (it?.id) itemById.set(it.id, it);
    }

    let { foundKeys, missingKeys, emittedEntries } =
      resolveEmittedCitationEntries(Array.from(itemById.values()), trimmedKeys);

    if (missingKeys.length > 0) {
      const aliasItems = this.exportsRepo.findItemsByMetadataAliases
        ? await this.exportsRepo.findItemsByMetadataAliases(
            scopeWhere,
            missingKeys,
          )
        : await this.exportsRepo.findItemsByScope(scopeWhere);
      for (const it of aliasItems) {
        if (it?.id && !itemById.has(it.id)) {
          itemById.set(it.id, it);
        }
      }
      ({ foundKeys, missingKeys, emittedEntries } =
        resolveEmittedCitationEntries(
          Array.from(itemById.values()),
          trimmedKeys,
        ));
    }

    const entries = emittedEntries.map(({ item: it, emitCiteKey }) => {
      const res = this.citationService.formatItem(
        this.toCitationItemInput(it, emitCiteKey),
        'bibtex',
      );
      return res.bibliography;
    });

    return {
      content: entries.join('\n\n'),
      count: emittedEntries.length,
      foundKeys,
      missingKeys,
    };
  }
}
