import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  Optional,
  Inject,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isUuid } from '@/core';
import {
  ExportsRepository,
  EXPORT_MAX_ITEMS,
  ExportItemRecord,
} from '@/modules/library/citation/repositories/exports.repository';
import { CitationService } from './citation.service';
import { ExportLibraryDto } from '@/modules/library/citation/dto/exports.dto';
import { PdfBakerService } from './pdf-baker.service';
import {
  ExportResult,
  BurnableAnnotation,
  ExportFormatType,
} from '@/modules/library/citation/types/exports.types';
import {
  resolveExportFormatStrategy,
  toCitationItemInput,
  formatItemsAsBibtex,
} from '@/modules/library/citation/domain/export-format.strategies';
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
      if (!collection) {
        throw new NotFoundException(
          `Collection ${dto.collectionId} not found or access denied`,
        );
      }
      if (collection.projectId) {
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
    const strategy = resolveExportFormatStrategy(dto.format);
    if (!strategy) {
      throw new BadRequestException(
        `Unsupported export format: ${(dto as { format: string }).format}`,
      );
    }

    return strategy.exportItems({
      items,
      timestamp,
      truncated,
      citationFormatter: this.citationService,
    });
  }

  async exportBundle(userId: string, collectionId: string, projectId?: string) {
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

    const bibtexContent = formatItemsAsBibtex(items, this.citationService);

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
    attachmentId?: string,
  ): Promise<{
    filename: string;
    mimeType: string;
    buffer: Buffer;
    base64: string;
  }> {
    const effectiveProjectId = normalizeProjectScopeId(projectId);
    if (effectiveProjectId && userId && this.exportsRepo.findProjectMember) {
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
      (attachmentId
        ? attachments.find((a) => a.id === attachmentId)
        : undefined) ||
      attachments.find(
        (a) =>
          (a as { attachmentType?: string }).attachmentType === 'primary_pdf',
      ) ||
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
    format: ExportFormatType = 'bibtex',
  ): Promise<{
    content: string;
    count: number;
    itemCount: number;
    filename: string;
    foundKeys: string[];
    missingKeys: string[];
  }> {
    const filename =
      'references.' +
      (format === 'ris' ? 'ris' : format === 'csl-json' ? 'json' : 'bib');
    if (!keys || keys.length === 0) {
      const emptyResult = {
        content: '',
        count: 0,
        foundKeys: [] as string[],
        missingKeys: [] as string[],
      };
      Object.defineProperties(emptyResult, {
        itemCount: { value: 0, enumerable: false, configurable: true },
        filename: { value: filename, enumerable: false, configurable: true },
      });
      return emptyResult as {
        content: string;
        count: number;
        itemCount: number;
        filename: string;
        foundKeys: string[];
        missingKeys: string[];
      };
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

    if (emittedEntries.length === 0) {
      const noMatchResult = {
        content: '',
        count: 0,
        foundKeys,
        missingKeys,
      };
      Object.defineProperties(noMatchResult, {
        itemCount: { value: 0, enumerable: false, configurable: true },
        filename: { value: filename, enumerable: false, configurable: true },
      });
      return noMatchResult as {
        content: string;
        count: number;
        itemCount: number;
        filename: string;
        foundKeys: string[];
        missingKeys: string[];
      };
    }

    const strategy = resolveExportFormatStrategy(format);
    let content: string;
    if (strategy && format !== 'bibtex' && format !== 'ris') {
      const exported = strategy.exportItems({
        items: emittedEntries.map(({ item: it, emitCiteKey }) => ({
          ...it,
          citationKey: emitCiteKey,
        })),
        timestamp: new Date().toISOString().split('T')[0],
        truncated: false,
        citationFormatter: this.citationService,
      });
      content = exported.content;
    } else {
      const targetStyle = format === 'ris' ? 'ris' : 'bibtex';
      const entries = emittedEntries.map(({ item: it, emitCiteKey }) => {
        const res = this.citationService.formatItem(
          toCitationItemInput(it, emitCiteKey),
          targetStyle,
        );
        return res.bibliography;
      });
      content = entries.join(targetStyle === 'ris' ? '\n' : '\n\n');
    }

    return {
      content,
      count: emittedEntries.length,
      itemCount: emittedEntries.length,
      filename,
      foundKeys,
      missingKeys,
    };
  }
}
