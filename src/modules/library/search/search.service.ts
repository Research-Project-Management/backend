import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ItemsRepository } from '../items/items.repository';
import { ItemsService } from '../items/items.service';
import { SearchCatalogQueryDto } from './dto/search.dto';

import { clampSearchLimit, normalizeSearchTerm } from './utils/search.util';
import {
  SearchLibraryDto,
  SearchFacetsResult,
  SavedSearch,
  FacetCount,
} from './types/search.types';

@Injectable()
export class SearchService {
  private readonly savedSearches = new Map<string, SavedSearch[]>(); // workspaceId -> SavedSearch[]

  constructor(
    private readonly itemsRepo: ItemsRepository,
    private readonly itemsService: ItemsService,
  ) {}

  async searchCatalog(workspaceId: string, dto: SearchCatalogQueryDto) {
    const query = normalizeSearchTerm(dto.query);
    const limit = clampSearchLimit(dto.limit);
    const skip = Math.max(Number(dto.skip ?? 0), 0);

    const result = await this.itemsService.getPapers(workspaceId, {
      collectionId: dto.collectionId,
      search: query,
      limit,
      skip,
    });

    return {
      query,
      total: result.total,
      limit,
      skip,
      items: result.items,
    };
  }

  /**
   * Calculates a metadata completeness quality score (0..100)
   */
  calculateQualityScore(item: Record<string, any>): number {
    let score = 0;
    if (item.title && item.title.trim().length > 3) score += 20;
    if (Array.isArray(item.authors) && item.authors.length > 0) score += 20;
    if (item.year && item.year > 1900) score += 15;
    if (item.doi || item.arxivId || item.pmid || item.isbn) score += 15;
    if (item.abstract && item.abstract.trim().length > 20) score += 15;
    if (item.journal || item.publisher || item.publicationTitle) score += 10;
    if (item.volume || item.issue || item.pages) score += 5;

    return Math.min(score, 100);
  }

  /**
   * Full-Text, Fuzzy and Faceted Search across the library catalog
   */
  async searchItems(workspaceId: string, dto: SearchLibraryDto) {
    const targetWsId = await this.itemsRepo.resolveWorkspaceId(workspaceId);
    const page = Math.max(1, dto.page || 1);
    const limit = Math.min(100, Math.max(1, dto.limit || 20));

    // Fetch all active items in workspace
    const items = await this.itemsRepo.findItems({
      workspaceId: targetWsId,
      deletedAt: null,
    });

    let filtered = items;

    // 1. Text Query Matching (title, abstract, authors, doi, citationKey, tags)
    if (dto.q && dto.q.trim()) {
      const qLower = dto.q.trim().toLowerCase();
      filtered = filtered.filter((it: any) => {
        const titleMatch = it.title?.toLowerCase().includes(qLower);
        const abstractMatch = it.abstract?.toLowerCase().includes(qLower);
        const authorsMatch = (it.authors || []).some((a: string) =>
          a.toLowerCase().includes(qLower),
        );
        const doiMatch = it.doi?.toLowerCase().includes(qLower);
        const keyMatch = it.citationKey?.toLowerCase().includes(qLower);
        const tagMatch = (it.labels || []).some((l: string) =>
          l.toLowerCase().includes(qLower),
        );

        return (
          titleMatch ||
          abstractMatch ||
          authorsMatch ||
          doiMatch ||
          keyMatch ||
          tagMatch
        );
      });
    }

    // 2. Facet filters
    if (dto.itemType) {
      filtered = filtered.filter((it: any) => it.itemType === dto.itemType);
    }
    if (dto.yearFrom) {
      filtered = filtered.filter(
        (it: any) => it.year && it.year >= dto.yearFrom!,
      );
    }
    if (dto.yearTo) {
      filtered = filtered.filter(
        (it: any) => it.year && it.year <= dto.yearTo!,
      );
    }
    if (dto.collectionId) {
      filtered = filtered.filter(
        (it: any) => it.collectionId === dto.collectionId,
      );
    }
    if (dto.readStatus) {
      filtered = filtered.filter((it: any) => {
        const status =
          it.readStatus ||
          (it.readingStatus ? String(it.readingStatus) : 'unread');
        return status === dto.readStatus;
      });
    }
    if (dto.hasPdf !== undefined) {
      filtered = filtered.filter((it: any) => {
        const has = Array.isArray(it.attachments) && it.attachments.length > 0;
        return dto.hasPdf ? has : !has;
      });
    }
    if (Array.isArray(dto.tags) && dto.tags.length > 0) {
      const requiredTags = new Set(dto.tags.map((t) => t.toLowerCase()));
      filtered = filtered.filter((it: any) => {
        const itemLabels = (it.labels || []).map((l: string) =>
          l.toLowerCase(),
        );
        return Array.from(requiredTags).some((req) => itemLabels.includes(req));
      });
    }

    // 3. Sorting
    const sortOrder = dto.sortOrder === 'asc' ? 1 : -1;
    filtered.sort((a: any, b: any) => {
      if (dto.sortBy === 'year') {
        const yA = a.year || 0;
        const yB = b.year || 0;
        return (yA - yB) * sortOrder;
      }
      if (dto.sortBy === 'title') {
        return (a.title || '').localeCompare(b.title || '') * sortOrder;
      }
      // default: dateAdded / createdAt desc
      const dateA = new Date(a.createdAt).getTime();
      const dateB = new Date(b.createdAt).getTime();
      return (dateA - dateB) * sortOrder;
    });

    const total = filtered.length;
    const startIdx = (page - 1) * limit;
    const paginated = filtered.slice(startIdx, startIdx + limit);

    // Attach computed quality scores
    const enriched = paginated.map((item: any) => ({
      ...item,
      qualityScore: this.calculateQualityScore(item),
    }));

    return {
      items: enriched,
      pagination: {
        page,
        limit,
        totalItems: total,
        totalPages: Math.ceil(total / limit) || 1,
        hasNextPage: page * limit < total,
        hasPrevPage: page > 1,
      },
    };
  }

  /**
   * Generates dynamic facet aggregations for a given query scope
   */
  async getSearchFacets(
    workspaceId: string,
    dto: SearchLibraryDto,
  ): Promise<SearchFacetsResult> {
    const targetWsId = await this.itemsRepo.resolveWorkspaceId(workspaceId);

    const items = await this.itemsRepo.findItems({
      workspaceId: targetWsId,
      deletedAt: null,
    });

    const itemTypeMap = new Map<string, number>();
    const yearMap = new Map<number, number>();
    const authorMap = new Map<string, number>();
    const tagMap = new Map<string, number>();
    const readStatusMap = new Map<string, number>();

    for (const it of items as any[]) {
      if (it.itemType) {
        itemTypeMap.set(it.itemType, (itemTypeMap.get(it.itemType) || 0) + 1);
      }
      if (it.year) {
        yearMap.set(it.year, (yearMap.get(it.year) || 0) + 1);
      }
      if (Array.isArray(it.authors)) {
        for (const author of it.authors) {
          if (author?.trim()) {
            authorMap.set(
              author.trim(),
              (authorMap.get(author.trim()) || 0) + 1,
            );
          }
        }
      }
      if (Array.isArray(it.labels)) {
        for (const label of it.labels) {
          if (label?.trim()) {
            tagMap.set(label.trim(), (tagMap.get(label.trim()) || 0) + 1);
          }
        }
      }
      const status =
        it.readStatus ||
        (it.readingStatus ? String(it.readingStatus) : 'unread');
      readStatusMap.set(status, (readStatusMap.get(status) || 0) + 1);
    }

    const toFacetList = <T>(map: Map<T, number>): FacetCount<T>[] =>
      Array.from(map.entries())
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count);

    return {
      itemTypes: toFacetList(itemTypeMap),
      years: toFacetList(yearMap),
      topAuthors: toFacetList(authorMap).slice(0, 20),
      tags: toFacetList(tagMap).slice(0, 30),
      readStatuses: toFacetList(readStatusMap),
    };
  }

  /**
   * Saved Searches API
   */
  async getSavedSearches(workspaceId: string): Promise<SavedSearch[]> {
    const targetWsId = await this.itemsRepo.resolveWorkspaceId(workspaceId);
    return this.savedSearches.get(targetWsId) || [];
  }

  async saveSearch(
    workspaceId: string,
    name: string,
    criteria: SearchLibraryDto,
  ): Promise<SavedSearch> {
    const targetWsId = await this.itemsRepo.resolveWorkspaceId(workspaceId);
    const now = new Date().toISOString();

    const search: SavedSearch = {
      id: randomUUID(),
      workspaceId: targetWsId,
      name,
      criteria,
      createdAt: now,
      updatedAt: now,
    };

    const list = this.savedSearches.get(targetWsId) || [];
    list.push(search);
    this.savedSearches.set(targetWsId, list);

    return search;
  }

  async deleteSavedSearch(
    workspaceId: string,
    searchId: string,
  ): Promise<boolean> {
    const targetWsId = await this.itemsRepo.resolveWorkspaceId(workspaceId);
    const list = this.savedSearches.get(targetWsId) || [];
    const filtered = list.filter((s) => s.id !== searchId);

    if (filtered.length === list.length) {
      throw new NotFoundException('Saved search not found');
    }

    this.savedSearches.set(targetWsId, filtered);
    return true;
  }
}

export { SearchService as LibrarySearchService };
