import { Injectable, Inject, Logger } from '@nestjs/common';
import { DeleteItemCommand } from './delete-item.command';
import {
  ITEM_REPOSITORY_PORT,
  IItemRepositoryPort,
} from '../../../domain/ports/item-repository.port';
import { ItemNotFoundDomainException } from '../../../domain/exceptions/item-domain.exception';

@Injectable()
export class DeleteItemUseCase {
  private readonly logger = new Logger(DeleteItemUseCase.name);

  constructor(
    @Inject(ITEM_REPOSITORY_PORT)
    private readonly itemRepo: IItemRepositoryPort,
  ) {}

  async execute(command: DeleteItemCommand): Promise<void> {
    this.logger.debug(
      `Executing DeleteItemUseCase for item ${command.itemId} (user: ${command.userId})`,
    );

    const aggregate = await this.itemRepo.findById(
      command.userId,
      command.itemId,
      command.projectId ?? undefined,
    );

    if (!aggregate) {
      throw new ItemNotFoundDomainException(command.itemId);
    }

    aggregate.softDelete(command.expectedVersion);
    await this.itemRepo.save(aggregate);
  }
}
