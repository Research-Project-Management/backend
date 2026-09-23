import { Injectable, Inject, Logger } from '@nestjs/common';
import {
  ITEM_REPOSITORY_PORT,
  IItemRepositoryPort,
} from '../../domain/ports/item-repository.port';
import { ItemResultDto, toItemResultDto } from '../dtos/item-result.dto';

export interface ListItemsQuery {
  userId: string;
  view?:
    | 'all' | 'recent' | 'unfiled' | 'trash' | 'my-publications' | 'publications';
  collectionId?: string;
  tagId?: string;
  search?: string;
  limit?: number;
  cursor?: string;
  projectId?: string;
  orderBy?: string;
  orderDirection?: 'asc' | 'desc';
  itemType?: string;
  fromYear?: number;
  toYear?: number;
  readStatus?: string;
  hasFile?: boolean;
}

export interface PaginatedItemsDto {
  items: ItemResultDto[];
  pagination: {
    cursor?: string;
    hasNextPage: boolean;
    totalCount: number;
  };
}

@Injectable()
export class ListItemsUseCase {
  private readonly logger = new Logger(ListItemsUseCase.name);

  constructor(
    @Inject(ITEM_REPOSITORY_PORT)
    private readonly itemRepo: IItemRepositoryPort,
  ) {}

  async execute(query: ListItemsQuery): Promise<PaginatedItemsDto> {
    this.logger.debug(
      `Executing ListItemsUseCase for user ${query.userId} (view: ${query.view ?? 'all'})`,
    );

    const result = await this.itemRepo.findMany(query.userId, {
      view: query.view,
      collectionId: query.collectionId,
      tagId: query.tagId,
      search: query.search,
      limit: query.limit,
      cursor: query.cursor,
      projectId: query.projectId,
      orderBy: query.orderBy,
      orderDirection: query.orderDirection,
      itemType: query.itemType,
      fromYear: query.fromYear,
      toYear: query.toYear,
      readStatus: query.readStatus,
      hasFile: query.hasFile,
    });

    return {
      items: result.items.map(toItemResultDto),
      pagination: {
        cursor: result.nextCursor,
        hasNextPage: result.hasNextPage,
        totalCount: result.totalCount,
      },
    };
  }
}
