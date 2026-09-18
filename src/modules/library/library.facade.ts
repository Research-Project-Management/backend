import { Injectable, Optional } from '@nestjs/common';
import { ExportsService } from './exports/exports.service';
import { QueryRepository } from './items/repositories/query.repository';
import { CslJsonMapper } from './citation/mappers/csl-json.mapper';

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
  exportBibByCitationKeys(
    userId: string,
    citeKeys: string[],
  ): Promise<{ content: string } | null>;
  getItem(
    scopeId: string,
    itemId: string,
  ): Promise<LibraryItemSummary | null>;
  countItems(scopeId: string): Promise<number>;
  searchItems(scopeId: string, query: string): Promise<LibraryItemSummary[]>;
}

export const LIBRARY_FACADE = 'LIBRARY_FACADE';

/**
 * Public Inter-Module Facade for Library Domain.
 * Serves as the single decoupled boundary for external modules (Document, LaTeX compiler, Search).
 */
@Injectable()
export class LibraryFacade implements ILibraryFacade {
  constructor(
    @Optional()
    private readonly exportsService?: ExportsService,
    @Optional()
    private readonly queryRepo?: QueryRepository,
  ) {}

  async exportBibByCitationKeys(
    userId: string,
    citeKeys: string[],
  ): Promise<{ content: string } | null> {
    if (!this.exportsService) {
      return null;
    }
    const res = await this.exportsService.exportByCitationKeys(
      userId,
      citeKeys,
    );
    if (!res || !res.content) {
      return null;
    }
    return { content: res.content };
  }

  async getItem(
    scopeId: string,
    itemId: string,
  ): Promise<LibraryItemSummary | null> {
    if (!this.queryRepo) return null;
    const item = await this.queryRepo.findById(scopeId, itemId);
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

  async countItems(scopeId: string): Promise<number> {
    if (!this.queryRepo) return 0;
    return this.queryRepo.count(scopeId, { view: 'all' });
  }

  async searchItems(
    scopeId: string,
    query: string,
  ): Promise<LibraryItemSummary[]> {
    if (!this.queryRepo) return [];
    const items = await this.queryRepo.findMany(scopeId, {
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
}
