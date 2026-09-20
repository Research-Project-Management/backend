import { Injectable, Inject, Logger } from '@nestjs/common';
import { RestoreItemCommand } from './restore-item.command';
import {
  ITEM_REPOSITORY_PORT,
  IItemRepositoryPort,
} from '../../../domain/ports/item-repository.port';
import { ItemNotFoundDomainException } from '../../../domain/exceptions/item-domain.exception';
import { ItemResultDto, toItemResultDto } from '../../dtos/item-result.dto';

@Injectable()
export class RestoreItemUseCase {
  private readonly logger = new Logger(RestoreItemUseCase.name);

  constructor(
    @Inject(ITEM_REPOSITORY_PORT)
    private readonly itemRepo: IItemRepositoryPort,
  ) {}

  async execute(command: RestoreItemCommand): Promise<ItemResultDto> {
    this.logger.debug(
      `Executing RestoreItemUseCase for item ${command.itemId} (user: ${command.userId})`,
    );

    const aggregate = await this.itemRepo.findById(
      command.userId,
      command.itemId,
      command.projectId ?? undefined,
    );

    if (!aggregate) {
      throw new ItemNotFoundDomainException(command.itemId);
    }

    aggregate.restore();
    await this.itemRepo.save(aggregate);

    return toItemResultDto(aggregate);
  }
}
