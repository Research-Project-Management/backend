import { Injectable, Inject, Optional } from '@nestjs/common';
import { Prisma, AttachmentExtractionStatus } from '@prisma/client';
import { PrismaService, RedisCacheService } from '@/core';
import { CatalogFacade } from './catalog/catalog.facade';
import { ItemCacheCoordinator } from './catalog/services/item-cache.coordinator';
import { ItemsMapper } from './catalog/domain/items.mapper';
import { SearchFacade } from './search/search.facade';
import { CitationFacade } from './citation/citation.facade';
import { ExtractionFacade } from './extraction/extraction.facade';
import { CslJsonMapper } from './citation';
import { ExportLibraryDto } from './citation/dto/exports.dto';
import { ExportResult } from './citation/types/exports.types';
import {
  ExtractedPdfDocument,
  harmonizeZoteroFields,
  LIBRARY_EVENT_TYPES,
  LIBRARY_REDIS_KEYS,
  normalizeProjectScopeId,
  UNIT_OF_WORK,
  IUnitOfWork,
  ItemProvenancePolicy,
} from './core';

export interface LibraryItemSummary {
  id: string;
  title: string;
  doi?: string | null;
  abstract?: string | null;
  year?: number | null;
  itemType: string;
  authors: string[];
}

export interface ILibraryFacade {
  listCollections(
    userId: string,
    projectId?: string,
  ): Promise<
    Array<{
      id: string;
      name: string;
      itemCount?: number;
      _count?: { collectionItems?: number };
    }>
  >;
  exportLibrary(
    userId: string,
    options?: ExportLibraryDto,
  ): Promise<ExportResult | null>;
  exportByCitationKeys(
    userId: string,
    citeKeys: string[],
    projectId?: string,
  ): Promise<{
    content: string;
    count: number;
    foundKeys: string[];
    missingKeys: string[];
  }>;
  getItem(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<LibraryItemSummary | null>;
  countItems(userId: string, options?: { projectId?: string }): Promise<number>;
  searchItems(
    userId: string,
    query: string,
    projectId?: string,
  ): Promise<LibraryItemSummary[]>;
  extractDocumentFromBuffer(
    buffer: Buffer,
    options?: { maxPages?: number; headerOnly?: boolean },
  ): Promise<ExtractedPdfDocument>;
  extractPdfBuffer(
    buffer: Buffer,
    filename?: string,
  ): Promise<ExtractedPdfDocument>;
  updateAttachmentProcessingStatus(
    attachmentId: string,
    status: string,
    metadataPatch?: Record<string, unknown>,
  ): Promise<void>;
  updateItemAiMetadata(
    itemId: string,
    aiMetadataPatch: Record<string, unknown>,
  ): Promise<void>;
  findAttachmentByFileId(
    fileId: string,
  ): Promise<{
    id: string;
    itemId: string;
    metadata?: unknown;
  } | null>;
}

export const LIBRARY_FACADE = 'LIBRARY_FACADE';

/**
 * Public Inter-Module Facade for Library Domain.
 * Serves as the single decoupled boundary for external modules (Document, LaTeX compiler, Search, AI).
 */
@Injectable()
export class LibraryFacade implements ILibraryFacade {
  private readonly itemCacheCoordinator: ItemCacheCoordinator;

  constructor(
    private readonly catalogFacade: CatalogFacade,
    private readonly extractionFacade: ExtractionFacade,
    private readonly searchFacade: SearchFacade,
    private readonly citationFacade: CitationFacade,
    @Optional()
    private readonly prisma?: PrismaService,
    @Optional()
    private readonly cache?: RedisCacheService,
    @Optional()
    @Inject(UNIT_OF_WORK)
    private readonly uow?: IUnitOfWork,
    @Optional()
    itemCacheCoordinator?: ItemCacheCoordinator,
  ) {
    this.itemCacheCoordinator =
      itemCacheCoordinator ?? new ItemCacheCoordinator(cache);
  }

  async listCollections(
    userId: string,
    projectId?: string,
  ): Promise<
    Array<{
      id: string;
      name: string;
      itemCount?: number;
      _count?: { collectionItems?: number };
    }>
  > {
    return this.catalogFacade.listCollections(userId, projectId);
  }

  async exportLibrary(
    userId: string,
    options: ExportLibraryDto = { format: 'bibtex' },
  ): Promise<ExportResult | null> {
    return this.citationFacade.exportLibrary(userId, options);
  }

  async exportByCitationKeys(
    userId: string,
    citeKeys: string[],
    projectId?: string,
  ): Promise<{
    content: string;
    count: number;
    foundKeys: string[];
    missingKeys: string[];
  }> {
    return this.citationFacade.exportByCitationKeys(
      userId,
      citeKeys,
      projectId,
    );
  }

  async getItem(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<LibraryItemSummary | null> {
    const item = await this.catalogFacade.getItem(userId, itemId, projectId);
    if (!item) return null;

    return {
      id: item.id,
      title: item.title,
      doi: item.doi,
      abstract: item.abstract,
      year: item.year,
      itemType: item.itemType || 'journalArticle',
      authors: CslJsonMapper.getAuthorNames(item),
    };
  }

  async countItems(
    userId: string,
    options?: { projectId?: string },
  ): Promise<number> {
    return this.catalogFacade.countItems(userId, {
      view: 'all',
      ...(options?.projectId ? { projectId: options.projectId } : {}),
    });
  }

  async searchItems(
    userId: string,
    query: string,
    projectId?: string,
  ): Promise<LibraryItemSummary[]> {
    const searchRes = await this.searchFacade.search(userId, {
      query,
      limit: 20,
      ...(projectId ? { projectId } : {}),
    });
    const rawItems = searchRes?.items ?? [];

    return rawItems.map((catalogItem) => ({
      id: catalogItem.id,
      title: catalogItem.title,
      doi: catalogItem.doi,
      abstract: catalogItem.abstract,
      year: catalogItem.year,
      itemType: catalogItem.itemType || 'journalArticle',
      authors: CslJsonMapper.getAuthorNames(catalogItem),
    }));
  }

  async extractDocumentFromBuffer(
    buffer: Buffer,
    options?: { maxPages?: number; headerOnly?: boolean },
  ): Promise<ExtractedPdfDocument> {
    return this.extractionFacade.extractDocumentFromBuffer(buffer, options);
  }

  async extractPdfBuffer(
    buffer: Buffer,
    _filename?: string,
  ): Promise<ExtractedPdfDocument> {
    return this.extractionFacade.extractDocumentFromBuffer(buffer);
  }

  async findAttachmentByFileId(
    fileId: string,
  ): Promise<{
    id: string;
    itemId: string;
    metadata?: unknown;
  } | null> {
    if (!this.prisma || !fileId) return null;
    return this.prisma.attachment.findFirst({
      where: { fileId, deletedAt: null },
      select: { id: true, itemId: true, metadata: true },
    });
  }

  async updateAttachmentProcessingStatus(
    attachmentId: string,
    status: string,
    metadataPatch?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.prisma || !attachmentId) return;
    const existing = await this.prisma.attachment.findUnique({
      where: { id: attachmentId },
      select: { id: true, itemId: true, metadata: true },
    });
    if (!existing) return;

    const currentMeta =
      existing.metadata &&
      typeof existing.metadata === 'object' &&
      !Array.isArray(existing.metadata)
        ? (existing.metadata as Record<string, unknown>)
        : {};

    const validExtractionStatuses = new Set<string>([
      'PENDING',
      'PROCESSING',
      'READY',
      'FAILED_RETRYABLE',
      'FAILED_FINAL',
    ]);
    const normalizedUpper = status.toUpperCase();
    const isExtractionEnum = validExtractionStatuses.has(normalizedUpper);

    await this.prisma.attachment.update({
      where: { id: attachmentId },
      data: {
        ...(isExtractionEnum
          ? {
              extractionStatus:
                normalizedUpper as AttachmentExtractionStatus,
            }
          : {}),
        metadata: {
          ...currentMeta,
          extractionStatus: status,
          ...(metadataPatch ?? {}),
        } as Prisma.InputJsonValue,
      },
    });

    if (existing.itemId && this.itemCacheCoordinator) {
      await this.itemCacheCoordinator.invalidateItemCache(
        existing.itemId,
        undefined,
        undefined,
        { skipScopeInvalidation: true },
      );
    } else if (existing.itemId && this.cache) {
      await this.cache.delPattern(LIBRARY_REDIS_KEYS.itemPattern(existing.itemId));
    }
  }

  async updateItemAiMetadata(
    itemId: string,
    aiMetadataPatch: Record<string, unknown>,
  ): Promise<void> {
    if (!this.prisma || !itemId) return;
    const existing = await this.prisma.item.findUnique({
      where: { id: itemId },
      select: {
        id: true,
        userId: true,
        projectId: true,
        itemType: true,
        metadata: true,
      },
    });
    if (!existing) return;

    const currentMeta =
      existing.metadata &&
      typeof existing.metadata === 'object' &&
      !Array.isArray(existing.metadata)
        ? (existing.metadata as Record<string, unknown>)
        : {};

    const validProjectId = normalizeProjectScopeId(existing.projectId);
    const effectiveItemType = String(existing.itemType || 'journalArticle');
    const rawPatch = { ...aiMetadataPatch };
    delete rawPatch.citationKey;
    delete rawPatch.citeKey;
    delete rawPatch.mergedCitationKeys;

    const BIBLIOGRAPHIC_PATCH_KEYS = new Set([
      'doi',
      'DOI',
      'isbn',
      'ISBN',
      'issn',
      'ISSN',
      'pmid',
      'PMID',
      'pmcid',
      'PMCID',
      'arxivid',
      'arxivId',
      'archiveid',
      'archiveID',
      'archiveId',
      'journalabbr',
      'journalAbbr',
      'journalAbbreviation',
      'abstract',
      'abstractNote',
      'journal',
      'publicationTitle',
      'venue',
      'proceedingsTitle',
      'bookTitle',
      'university',
      'institution',
      'date',
      'publicationDate',
      'year',
      'title',
    ]);
    const hasBibliographicFields = Object.keys(rawPatch).some((k) =>
      BIBLIOGRAPHIC_PATCH_KEYS.has(k),
    );
    const sanitizedPatch = hasBibliographicFields
      ? harmonizeZoteroFields(rawPatch, {
          itemType: effectiveItemType,
          syncExtraFields: false,
          syncLegacyAliases: false,
        })
      : rawPatch;
    for (const transientAlias of [
      'DOI',
      'ISBN',
      'ISSN',
      'PMID',
      'PMCID',
      'archiveID',
      'citeKey',
      'URL',
    ]) {
      delete sanitizedPatch[transientAlias];
    }

    const { filteredPatch, updatedFieldProvenance } =
      ItemProvenancePolicy.filterAiMetadataPatch(currentMeta, sanitizedPatch);

    const mergedMetadata = {
      ...currentMeta,
      ...filteredPatch,
      ...(updatedFieldProvenance
        ? { fieldProvenance: updatedFieldProvenance }
        : {}),
    } as Prisma.InputJsonValue;

    if (this.uow && existing.userId) {
      await this.uow.executeInTransaction(async (tx, helpers) => {
        const client = tx?.item ? tx : this.prisma!;
        const updated = await client.item.update({
          where: { id: itemId },
          data: {
            metadata: mergedMetadata,
            version: { increment: 1 },
          },
        });
        const domainUpdated = ItemsMapper.toDomain(updated);
        const eventScope = {
          userId: existing.userId,
          projectId: validProjectId,
        };
        await helpers.appendChange(eventScope, {
          entityType: 'Item',
          entityId: itemId,
          action: 'update',
          version: updated.version ?? 1,
          data: domainUpdated,
        });
        await helpers.publishOutbox(
          eventScope,
          itemId,
          LIBRARY_EVENT_TYPES.ITEM_UPDATED,
          domainUpdated,
        );
      });
    } else {
      await this.prisma.item.update({
        where: { id: itemId },
        data: {
          metadata: mergedMetadata,
          version: { increment: 1 },
        },
      });
    }

    if (this.itemCacheCoordinator) {
      await this.itemCacheCoordinator.invalidateItemCache(
        itemId,
        existing.userId,
        validProjectId,
      );
    } else if (this.cache) {
      await this.cache.delPattern(LIBRARY_REDIS_KEYS.itemPattern(itemId));
    }
  }
}
