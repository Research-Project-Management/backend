import { Injectable, Inject, Logger } from '@nestjs/common';
import {
  ITEM_REPOSITORY_PORT,
  IItemRepositoryPort,
} from '../../domain/ports/item-repository.port';
import { ItemResultDto, toItemResultDto } from '../dtos/item-result.dto';

export interface GetItemQuery {
  userId: string;
  itemId: string;
  projectId?: string | null;
}

@Injectable()
export class GetItemUseCase {
  private readonly logger = new Logger(GetItemUseCase.name);

  constructor(
    @Inject(ITEM_REPOSITORY_PORT)
    private readonly itemRepo: IItemRepositoryPort,
  ) {}

  async execute(query: GetItemQuery): Promise<ItemResultDto | null> {
    const aggregate = await this.itemRepo.findById(
      query.userId,
      query.itemId,
      query.projectId ?? undefined,
    );

    if (!aggregate || aggregate.isDeleted) {
      return null;
    }

    return toItemResultDto(aggregate);
  }
}
