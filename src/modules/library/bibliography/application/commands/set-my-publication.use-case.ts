import { Injectable, Inject, NotFoundException, Logger } from '@nestjs/common';
import {
  ITEM_REPOSITORY_PORT,
  IItemRepositoryPort,
} from '../../domain/ports/item-repository.port';
import { ItemAggregate } from '../../domain/model/item.aggregate';

export interface SetMyPublicationCommand {
  userId: string;
  itemId: string;
  isMyPublication: boolean;
}

@Injectable()
export class SetMyPublicationUseCase {
  private readonly logger = new Logger(SetMyPublicationUseCase.name);

  constructor(
    @Inject(ITEM_REPOSITORY_PORT)
    private readonly itemRepo: IItemRepositoryPort,
  ) {}

  async execute(command: SetMyPublicationCommand): Promise<ItemAggregate> {
    const { userId, itemId, isMyPublication } = command;
    this.logger.debug(
      `Setting myPublication=${isMyPublication} for item ${itemId} (user ${userId})`,
    );

    const updated = await this.itemRepo.setMyPublication(
      userId,
      itemId,
      isMyPublication,
    );
    if (!updated) {
      throw new NotFoundException(`Item ${itemId} not found`);
    }

    return updated;
  }
}
