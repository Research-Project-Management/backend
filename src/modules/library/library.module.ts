import { Module, Injectable, Inject } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CoreModule as AppCoreModule } from '@/core';

// The 6 Canonical Symmetrical Bounded Context Modules
import { SyncModule } from './sync/sync.module';
import { CatalogModule } from './catalog/catalog.module';
import { ExtractionModule } from './extraction/extraction.module';
import { IngestionModule } from './ingestion/ingestion.module';
import { SearchModule } from './search/search.module';
import { CitationModule } from './citation/citation.module';

// Core (primitives, resilience & cross-cutting concerns)
import { LibraryCoreModule } from './core/core.module';
import { ExportResult } from './citation/types/citation.types';
import { ExportLibraryDto } from './citation/dto/citation.dto';
import {
  CATALOG_FACADE,
  ICatalogFacade,
  EXTRACTION_FACADE,
  IExtractionFacade,
  SEARCH_FACADE,
  ISearchFacade,
  CITATION_FACADE,
  ICitationFacade,
  ExtractedPdfDocument,
  formatAuthors,
} from './core';

interface LibraryItemSummary {
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
    scope?: { userId?: string; projectId?: string },
  ): Promise<void>;
  updateItemAiMetadata(
    itemId: string,
    aiMetadataPatch: Record<string, unknown>,
    scope?: { userId?: string; projectId?: string },
  ): Promise<void>;
  findAttachmentByFileId(
    fileId: string,
    scope?: { userId?: string; projectId?: string },
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
    @Inject(CATALOG_FACADE)
    private readonly catalogFacade: ICatalogFacade,
    @Inject(EXTRACTION_FACADE)
    private readonly extractionFacade: IExtractionFacade,
    @Inject(SEARCH_FACADE)
    private readonly searchFacade: ISearchFacade,
    @Inject(CITATION_FACADE)
    private readonly citationFacade: ICitationFacade<
      string,
      unknown,
      ExportLibraryDto,
      ExportResult | null
    >,
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

  async findAttachmentByFileId(
    fileId: string,
    scope?: { userId?: string; projectId?: string },
  ): Promise<{
    id: string;
    itemId: string;
    metadata?: unknown;
  } | null> {
    return this.catalogFacade.findAttachmentByFileId(fileId, scope);
  }

  async updateAttachmentProcessingStatus(
    attachmentId: string,
    status: string,
    metadataPatch?: Record<string, unknown>,
    scope?: { userId?: string; projectId?: string },
  ): Promise<void> {
    await this.catalogFacade.updateAttachmentProcessingStatus(
      attachmentId,
      status,
      metadataPatch,
      scope,
    );
  }

  async updateItemAiMetadata(
    itemId: string,
    aiMetadataPatch: Record<string, unknown>,
    scope?: { userId?: string; projectId?: string },
  ): Promise<void> {
    await this.catalogFacade.updateItemAiMetadata(itemId, aiMetadataPatch, scope);
  }
}

/**
 * Macro Composition Root for the Library Subsystem.
 *
 * Modular Monolith Architecture matching Manuscripts / Overleaf Scale (1M+ Users):
 * Consists of 6 Domain Sub-Modules + 1 Core Module + 1 Unified Facade:
 *
 * 1. SyncModule        — CDC, Outbox, Monotonic Sequence, TransactionService
 * 2. CatalogModule     — Metadata (37 CSL Types), OCC, Collections, Tags, Notes, Annotations
 * 3. ExtractionModule  — In-Process Trusted Extractor (XMP, Regex, Layout), OCR, Sandwich PDF, Claim-Check S3
 * 4. IngestionModule   — CrossRef/arXiv/PubMed Pipeline, Dedup, Retraction Watch
 * 5. SearchModule      — Postgres FTS, Semantic Vector, Event-driven Indexing
 * 6. CitationModule    — CSL Engine, 10k+ Styles, DOI Negotiation, Multi-format Exports
 * 7. LibraryCoreModule — Domain primitives, Zotero schema, resilience, security & middlewares
 */
@Module({
  imports: [
    ConfigModule,
    AppCoreModule,
    LibraryCoreModule,
    SyncModule,
    CatalogModule,
    ExtractionModule,
    IngestionModule,
    SearchModule,
    CitationModule,
  ],
  providers: [
    LibraryFacade,
    {
      provide: LIBRARY_FACADE,
      useExisting: LibraryFacade,
    },
  ],
  exports: [
    LibraryFacade,
    LIBRARY_FACADE,
    CatalogModule,
    ExtractionModule,
    CitationModule,
    IngestionModule,
    SearchModule,
  ],
})
export class LibraryModule {}
