import { Injectable, Optional } from '@nestjs/common';
import { Prisma, AttachmentExtractionStatus } from '@prisma/client';
import { PrismaService, RedisCacheService } from '@/core';
import { CatalogFacade } from './catalog/catalog.facade';
import { SearchFacade } from './search/search.facade';
import { CitationFacade } from './citation/citation.facade';
import { ExtractionFacade } from './extraction/extraction.facade';
import { CslJsonMapper } from './citation';
import { ExportLibraryDto } from './citation/dto/exports.dto';
import { ExportResult } from './citation/types/exports.types';
import {
  ExtractedPdfDocument,
  LIBRARY_REDIS_KEYS,
  normalizeProjectScopeId,
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
  constructor(
    private readonly catalogFacade: CatalogFacade,
    private readonly extractionFacade: ExtractionFacade,
    private readonly searchFacade: SearchFacade,
    private readonly citationFacade: CitationFacade,
    @Optional()
    private readonly prisma?: PrismaService,
    @Optional()
    private readonly cache?: RedisCacheService,
  ) {}

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

    if (this.cache && existing.itemId) {
      await Promise.all([
        this.cache.del(LIBRARY_REDIS_KEYS.item(existing.itemId)),
        this.cache.del(LIBRARY_REDIS_KEYS.itemDetails(existing.itemId)),
        this.cache.del(`library:item:${existing.itemId}:attachments`),
        this.cache.delPattern(LIBRARY_REDIS_KEYS.itemPattern(existing.itemId)),
      ]);
    }
  }

  async updateItemAiMetadata(
    itemId: string,
    aiMetadataPatch: Record<string, unknown>,
  ): Promise<void> {
    if (!this.prisma || !itemId) return;
    const existing = await this.prisma.item.findUnique({
      where: { id: itemId },
      select: { id: true, userId: true, projectId: true, metadata: true },
    });
    if (!existing) return;

    const currentMeta =
      existing.metadata &&
      typeof existing.metadata === 'object' &&
      !Array.isArray(existing.metadata)
        ? (existing.metadata as Record<string, unknown>)
        : {};

    await this.prisma.item.update({
      where: { id: itemId },
      data: {
        metadata: {
          ...currentMeta,
          ...aiMetadataPatch,
        } as Prisma.InputJsonValue,
        version: { increment: 1 },
      },
    });

    if (this.cache) {
      const validProjectId = normalizeProjectScopeId(existing.projectId);
      const scopeId = validProjectId || existing.userId;
      const tasks: Promise<unknown>[] = [
        this.cache.del(LIBRARY_REDIS_KEYS.item(itemId)),
        this.cache.del(LIBRARY_REDIS_KEYS.itemDetails(itemId)),
        this.cache.delPattern(LIBRARY_REDIS_KEYS.itemPattern(itemId)),
      ];
      if (scopeId) {
        tasks.push(
          this.cache.delPattern(LIBRARY_REDIS_KEYS.itemsPattern(scopeId)),
          this.cache.delPattern(LIBRARY_REDIS_KEYS.countsPattern(scopeId)),
        );
      }
      await Promise.all(tasks);
    }
  }
}
