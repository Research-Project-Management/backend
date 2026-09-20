import { Injectable, Inject, Logger } from '@nestjs/common';
import {
  ITEM_REPOSITORY_PORT,
  IItemRepositoryPort,
} from '../../domain/ports/item-repository.port';
import { ItemNotFoundDomainException } from '../../domain/exceptions/item-domain.exception';
import { ItemResultDto, toItemResultDto } from '../dtos/item-result.dto';

export interface UpdateItemCommand {
  userId: string;
  itemId: string;
  projectId?: string | null;
  expectedVersion?: number;
  changes: {
    title?: string;
    itemType?: string;
    doi?: string | null;
    citationKey?: string | null;
    abstract?: string | null;
    year?: number | null;
    publicationTitle?: string | null;
    fields?: Record<string, any>;
  };
  correlationId?: string;
}

@Injectable()
export class UpdateItemUseCase {
  private readonly logger = new Logger(UpdateItemUseCase.name);

  constructor(
    @Inject(ITEM_REPOSITORY_PORT)
    private readonly itemRepo: IItemRepositoryPort,
  ) {}

  async execute(command: UpdateItemCommand): Promise<ItemResultDto> {
    this.logger.debug(
      `Executing UpdateItemUseCase for item ${command.itemId} (user: ${command.userId})`,
    );

    // 1. Load domain aggregate
    const aggregate = await this.itemRepo.findById(
      command.userId,
      command.itemId,
      command.projectId ?? undefined,
    );

    if (!aggregate) {
      throw new ItemNotFoundDomainException(command.itemId);
    }

    // 2. Mutate aggregate via domain methods (enforces invariants & versioning)
    aggregate.updateMetadata(command.changes, command.expectedVersion);

    // 3. Persist modified aggregate
    await this.itemRepo.save(aggregate);

    // 4. Return DTO
    return toItemResultDto(aggregate);
  }
}
