import { Injectable, Inject, Logger } from '@nestjs/common';
import { ItemAggregate } from '../../domain/model/item.aggregate';
import {
  ITEM_REPOSITORY_PORT,
  IItemRepositoryPort,
} from '../../domain/ports/item-repository.port';
import { ItemResultDto, toItemResultDto } from '../dtos/item-result.dto';

export interface CreateItemCommand {
  userId: string;
  projectId?: string | null;
  title: string;
  itemType: string;
  doi?: string | null;
  citationKey?: string | null;
  abstract?: string | null;
  year?: number | null;
  publicationTitle?: string | null;
  fields?: Record<string, any>;
  idempotencyKey?: string;
  correlationId?: string;
}

@Injectable()
export class CreateItemUseCase {
  private readonly logger = new Logger(CreateItemUseCase.name);

  constructor(
    @Inject(ITEM_REPOSITORY_PORT)
    private readonly itemRepo: IItemRepositoryPort,
  ) {}

  async execute(command: CreateItemCommand): Promise<ItemResultDto> {
    this.logger.debug(`Executing CreateItemUseCase for user ${command.userId}`);

    // 1. Create Domain Aggregate (enforces domain rules & invariants)
    const aggregate = ItemAggregate.create({
      userId: command.userId,
      projectId: command.projectId,
      title: command.title,
      itemType: command.itemType,
      doi: command.doi,
      citationKey: command.citationKey,
      abstract: command.abstract,
      year: command.year,
      publicationTitle: command.publicationTitle,
      fields: command.fields,
    });

    // 2. Persist aggregate via domain repository port
    await this.itemRepo.save(aggregate);

    // 3. Return application result DTO
    return toItemResultDto(aggregate);
  }
}
