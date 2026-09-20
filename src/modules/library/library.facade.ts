import { Injectable, Optional } from '@nestjs/common';
import { CatalogFacade } from './catalog/catalog.facade';
import { DiscoveryFacade } from './discovery/discovery.facade';
import { ContentFacade } from './content/content.facade';
import { CslJsonMapper } from './discovery/application/mappers/csl-json.mapper';

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
  getItem(scopeId: string, itemId: string): Promise<LibraryItemSummary | null>;
  getItemWithDetails(
    scopeId: string,
    itemId: string,
    projectId?: string,
  ): Promise<LibraryItemDetail | null>;
  countItems(scopeId: string): Promise<number>;
  searchItems(scopeId: string, query: string): Promise<LibraryItemSummary[]>;
  extractDocumentFromBuffer(
    buffer: Buffer,
    options?: any,
  ): Promise<any>;
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
    private readonly catalogFacade?: CatalogFacade,
    @Optional()
    private readonly discoveryFacade?: DiscoveryFacade,
    @Optional()
    private readonly contentFacade?: ContentFacade,
  ) {}

  async exportBibByCitationKeys(
    userId: string,
    citeKeys: string[],
  ): Promise<{ content: string } | null> {
    if (!this.discoveryFacade) {
      return null;
    }
    return this.discoveryFacade.exportBibliography(userId, citeKeys);
  }

  async getItem(
    scopeId: string,
    itemId: string,
  ): Promise<LibraryItemSummary | null> {
    if (!this.catalogFacade) return null;
    const item = await this.catalogFacade.getItem(scopeId, itemId);
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
    scopeId: string,
    itemId: string,
    projectId?: string,
  ): Promise<LibraryItemDetail | null> {
    if (!this.catalogFacade) return null;

    // Scatter-gather across Bounded Contexts (Microservices-Ready)
    const [catalogItem, attachmentsRes, notes] = await Promise.all([
      this.catalogFacade.getItem(scopeId, itemId, projectId),
      this.contentFacade
        ? this.contentFacade.getItemAttachments(scopeId, itemId)
        : Promise.resolve({ attachments: [] }),
      this.contentFacade
        ? this.contentFacade.listNotes(scopeId, itemId, projectId)
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

  async countItems(scopeId: string): Promise<number> {
    if (!this.catalogFacade) return 0;
    return this.catalogFacade.countItems(scopeId, { view: 'all' });
  }

  async searchItems(
    scopeId: string,
    query: string,
  ): Promise<LibraryItemSummary[]> {
    if (!this.catalogFacade) return [];
    const items = await this.catalogFacade.findMany(scopeId, {
      search: query,
      limit: 20,
    });

    return items.map((it) => ({
      id: it.id,
      title: it.title,
      doi: it.doi,
      abstract: it.abstract,
      year: it.year,
      itemType: it.itemType || 'journalArticle',
      authors: CslJsonMapper.getAuthorNames(it),
    }));
  }

  async extractDocumentFromBuffer(
    buffer: Buffer,
    options?: any,
  ): Promise<any> {
    if (!this.contentFacade) {
      throw new Error('ContentFacade is not initialized in LibraryFacade');
    }
    return this.contentFacade.extractDocumentFromBuffer(buffer, options);
  }
}

