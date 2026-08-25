import { Injectable } from '@nestjs/common';
import { CatalogService } from '../catalog/catalog.service';
import { SearchCatalogQueryDto } from './dto/search.dto';
import { clampSearchLimit, normalizeSearchTerm } from './search.util';

@Injectable()
export class SearchService {
  constructor(private readonly catalogService: CatalogService) {}

  /**
   * Search catalog items by query string across title, abstract, authors, journal, publisher, doi, citationKey
   */
  async searchCatalog(workspaceId: string, dto: SearchCatalogQueryDto) {
    const query = normalizeSearchTerm(dto.query);
    const limit = clampSearchLimit(dto.limit);
    const skip = Math.max(Number(dto.skip ?? 0), 0);

    const result = await this.catalogService.getPapers(workspaceId, {
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
}
