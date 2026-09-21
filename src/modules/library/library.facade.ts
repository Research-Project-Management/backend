import { Injectable, Optional } from '@nestjs/common';
import {
  BibliographyFacade,
  CatalogFacade,
} from './bibliography/bibliography.facade';
import { SearchFacade } from './search/search.facade';
import { CitationFacade } from './citation/citation.facade';
import { ReaderFacade, ContentFacade } from './reader/reader.facade';
import { CslJsonMapper } from './citation/application/mappers/csl-json.mapper';

export interface LibraryItemSummary {
  id: string;
  title: string;
  doi?: string | null;
  abstract?: string | null;
  year?: number | null;
  itemType: string;
  authors: string[];
}

export interface LibraryItemDetail extends LibraryItemSummary {
  attachments: any[];
  notes: any[];
  tags: any[];
  collections: any[];
}

export interface ILibraryFacade {
  exportBibByCitationKeys(
    userId: string,
    citeKeys: string[],
  ): Promise<{ content: string } | null>;
  getItem(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<LibraryItemSummary | null>;
  getItemWithDetails(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<LibraryItemDetail | null>;
  countItems(userId: string, options?: { projectId?: string }): Promise<number>;
  searchItems(
    userId: string,
    query: string,
    projectId?: string,
  ): Promise<LibraryItemSummary[]>;
  extractDocumentFromBuffer(buffer: Buffer, options?: any): Promise<any>;
}

export const LIBRARY_FACADE = 'LIBRARY_FACADE';

/**
 * Public Inter-Module Facade for Library Domain.
 * Serves as the single decoupled boundary for external modules (Document, LaTeX compiler, Search, AI).
 */
@Injectable()
export class LibraryFacade implements ILibraryFacade {
  constructor(
    @Optional()
    private readonly bibliographyFacade?: BibliographyFacade,
    @Optional()
    private readonly readerFacade?: ReaderFacade,
    @Optional()
    private readonly searchFacade?: SearchFacade,
    @Optional()
    private readonly citationFacade?: CitationFacade,
  ) {}

  get catalogFacade(): BibliographyFacade | undefined {
    return this.bibliographyFacade;
  }

  get contentFacade(): ReaderFacade | undefined {
    return this.readerFacade;
  }

  get search(): SearchFacade | undefined {
    return this.searchFacade;
  }

  get citation(): CitationFacade | undefined {
    return this.citationFacade;
  }

  async exportBibByCitationKeys(
    userId: string,
    citeKeys: string[],
  ): Promise<{ content: string } | null> {
    if (this.citationFacade) {
      return this.citationFacade.exportBibliography(userId, citeKeys);
    }
    return null;
  }

  async getItem(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<LibraryItemSummary | null> {
    if (!this.catalogFacade) return null;
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

  async getItemWithDetails(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<LibraryItemDetail | null> {
    if (!this.catalogFacade) return null;

    // Scatter-gather across Bounded Contexts (Microservices-Ready)
    const [catalogItem, attachmentsRes, notes] = await Promise.all([
      this.catalogFacade.getItem(userId, itemId, projectId),
      this.contentFacade
        ? this.contentFacade.getItemAttachments(userId, itemId)
        : Promise.resolve({ attachments: [] }),
      this.contentFacade
        ? this.contentFacade.listNotes(userId, itemId, projectId)
        : Promise.resolve([]),
    ]);

    if (!catalogItem) return null;

    const attachments = Array.isArray(attachmentsRes)
      ? attachmentsRes
      : attachmentsRes?.attachments || [];

    return {
      id: catalogItem.id,
      title: catalogItem.title,
      doi: catalogItem.doi,
      abstract: catalogItem.abstract,
      year: catalogItem.year,
      itemType: catalogItem.itemType || 'journalArticle',
      authors: CslJsonMapper.getAuthorNames(catalogItem),
      attachments,
      notes: Array.isArray(notes) ? notes : [],
      tags: (catalogItem as any).tags || [],
      collections: (catalogItem as any).collections || [],
    };
  }

  async countItems(
    userId: string,
    options?: { projectId?: string },
  ): Promise<number> {
    if (!this.catalogFacade) return 0;
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
    if (!this.catalogFacade) return [];
    const items = await this.catalogFacade.findMany(userId, {
      search: query,
      limit: 20,
      ...(projectId ? { projectId } : {}),
    });

    return items.map((it: any) => ({
      id: it.id,
      title: it.title,
      doi: it.doi,
      abstract: it.abstract,
      year: it.year,
      itemType: it.itemType || 'journalArticle',
      authors: CslJsonMapper.getAuthorNames(it),
    }));
  }

  async extractDocumentFromBuffer(buffer: Buffer, options?: any): Promise<any> {
    if (!this.contentFacade) {
      throw new Error('ContentFacade is not initialized in LibraryFacade');
    }
    return this.contentFacade.extractDocumentFromBuffer(buffer, options);
  }
}
