import { Injectable } from '@nestjs/common';
import { CatalogFacade } from './catalog/catalog.facade';
import { SearchFacade } from './search/search.facade';
import { CitationFacade } from './citation/citation.facade';
import { ExtractionFacade } from './extraction/extraction.facade';
import { ExportLibraryDto } from './citation/dto/exports.dto';
import { ExportResult } from './citation/types/exports.types';
import { ExtractedPdfDocument, formatAuthors } from './core';

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
  updateAttachmentProcessingStatus(
    attachmentId: string,
    status: string,
    metadataPatch?: Record<string, unknown>,
  ): Promise<void>;
  updateItemAiMetadata(
    itemId: string,
    aiMetadataPatch: Record<string, unknown>,
  ): Promise<void>;
  findAttachmentByFileId(fileId: string): Promise<{
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
      authors: formatAuthors(item),
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
      authors: formatAuthors(catalogItem),
    }));
  }

  async extractDocumentFromBuffer(
    buffer: Buffer,
    options?: { maxPages?: number; headerOnly?: boolean },
  ): Promise<ExtractedPdfDocument> {
    return this.extractionFacade.extractDocumentFromBuffer(buffer, options);
  }

  async findAttachmentByFileId(fileId: string): Promise<{
    id: string;
    itemId: string;
    metadata?: unknown;
  } | null> {
    return this.catalogFacade.findAttachmentByFileId(fileId);
  }

  async updateAttachmentProcessingStatus(
    attachmentId: string,
    status: string,
    metadataPatch?: Record<string, unknown>,
  ): Promise<void> {
    await this.catalogFacade.updateAttachmentProcessingStatus(
      attachmentId,
      status,
      metadataPatch,
    );
  }

  async updateItemAiMetadata(
    itemId: string,
    aiMetadataPatch: Record<string, unknown>,
  ): Promise<void> {
    await this.catalogFacade.updateItemAiMetadata(itemId, aiMetadataPatch);
  }
}
