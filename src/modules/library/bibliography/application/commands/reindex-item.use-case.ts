import {
  Injectable,
  NotFoundException,
  Optional,
  Inject,
  Logger,
} from '@nestjs/common';
import {
  ITEM_REPOSITORY_PORT,
  IItemRepositoryPort,
} from '../../domain/ports/item-repository.port';
import { SEARCH_FACADE, ISearchFacade } from '../../../search/search.facade';
import { TransactionService } from '../../../shared-kernel/outbox/transaction.service';

export interface ReindexItemCommand {
  userId: string;
  itemId: string;
  projectId?: string;
}

export interface ReindexItemResult {
  success: boolean;
  message: string;
  itemId: string;
}

/**
 * Command Use Case — Reindex Item
 *
 * Clean Architecture & DDD:
 * 1. Refreshes local library search indexing (FTS / facets).
 * 2. Emits outbox event `library.item.reindexed` for asynchronous AI / vector processing.
 */
@Injectable()
export class ReindexItemUseCase {
  private readonly logger = new Logger(ReindexItemUseCase.name);

  constructor(
    @Inject(ITEM_REPOSITORY_PORT)
    private readonly itemRepo: IItemRepositoryPort,
    private readonly libraryTx: TransactionService,
    @Optional()
    @Inject(SEARCH_FACADE)
    private readonly searchFacade?: ISearchFacade,
  ) {}

  async execute(command: ReindexItemCommand): Promise<ReindexItemResult> {
    const item = await this.itemRepo.findById(
      command.userId,
      command.itemId,
      command.projectId,
    );
    if (!item) {
      throw new NotFoundException(
        `Item ${command.itemId} not found in user library`,
      );
    }

    const effectiveProjectId =
      command.projectId ?? (item as any).projectId ?? undefined;
    const eventScope = {
      userId: command.userId,
      projectId: effectiveProjectId,
    };

    // 1. Transactionally publish domain event for external listeners (e.g. AI / Vector module)
    await this.libraryTx.executeInTransaction(async (_tx, helpers) => {
      await helpers.publishOutbox(
        eventScope,
        command.itemId,
        'library.item.reindexed',
        {
          itemId: command.itemId,
          userId: command.userId,
          projectId: effectiveProjectId,
        },
      );
    });

    // 2. Refresh local search facade index if present
    if (this.searchFacade) {
      try {
        await this.searchFacade.reindexItem(item);
      } catch (err: any) {
        this.logger.warn(
          `Local search facade reindex warning for item ${command.itemId}: ${err?.message}`,
        );
      }
    }

    return {
      success: true,
      message: 'Item re-indexing requested',
      itemId: command.itemId,
    };
  }
}
