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
 * Command Use Case — Reindex Item for RAG / Semantic Search
 *
 * Clean Architecture & DDD: Depends strictly on Domain Ports (IItemRepositoryPort)
 * without concrete repository or Prisma coupling.
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
    @Optional() private readonly rag?: any,
    @Optional() private readonly semanticSearch?: any,
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

    // Fire-and-forget — do not await
    this.runRagIndexing(item).catch((err) => {
      this.logger.error(
        `Failed to index paper ${command.itemId}: ${err.message}`,
      );
    });

    return {
      success: true,
      message: 'Item re-indexing started',
      itemId: command.itemId,
    };
  }

  private async runRagIndexing(item: any): Promise<void> {
    await this.itemRepo.updateRagStatus(item.id, {
      ragStatus: 'pending',
      ragLastAttemptAt: new Date(),
    });

    if (this.searchFacade) {
      try {
        const res = await this.searchFacade.reindexItem(item);
        if (res.docId) {
          await this.itemRepo.updateRagStatus(item.id, {
            ragDocId: res.docId,
            ragStatus: 'indexed',
            ragIndexedAt: new Date(),
          });
          this.logger.log(
            `Paper ${item.id} successfully indexed into Qdrant (docId: ${res.docId})`,
          );
        } else if (res.localIndexed) {
          await this.itemRepo.updateRagStatus(item.id, {
            ragStatus: 'indexed',
            ragIndexedAt: new Date(),
          });
          this.logger.log(
            `Paper ${item.id} indexed into local vector store (external Qdrant offline).`,
          );
        } else {
          const errorMsg = res.error || 'External RAG unavailable';
          await this.itemRepo.updateRagStatus(item.id, {
            ragStatus: 'failed',
            ragError: errorMsg,
          });
          this.logger.error(`Failed to index paper ${item.id}: ${errorMsg}`);
        }
      } catch (err: any) {
        const errorMsg = err?.message || 'External RAG unavailable';
        await this.itemRepo.updateRagStatus(item.id, {
          ragStatus: 'failed',
          ragError: errorMsg,
        });
        this.logger.error(`Failed to index paper ${item.id}: ${errorMsg}`);
      }
      return;
    }

    let localIndexed = false;

    // 1. In-process local semantic vector indexing (offline, zero API)
    try {
      if (this.semanticSearch) {
        await this.semanticSearch.indexItem(item);
        localIndexed = true;
      }
    } catch (err: any) {
      this.logger.debug(`Local semantic indexing skipped: ${err?.message}`);
    }

    // 2. External Qdrant indexing if FLUX_AI_URL is available
    try {
      if (!this.rag) throw new Error('RagProvider not configured');
      const result = await this.rag.indexPaper(item);
      await this.itemRepo.updateRagStatus(item.id, {
        ragDocId: result.docId,
        ragStatus: 'indexed',
        ragIndexedAt: new Date(),
      });
      this.logger.log(
        `Paper ${item.id} successfully indexed into Qdrant (docId: ${result.docId})`,
      );
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'External RAG unavailable';
      if (localIndexed) {
        await this.itemRepo.updateRagStatus(item.id, {
          ragStatus: 'indexed',
          ragIndexedAt: new Date(),
        });
        this.logger.log(
          `Paper ${item.id} indexed into local vector store (external Qdrant offline).`,
        );
      } else {
        await this.itemRepo.updateRagStatus(item.id, {
          ragStatus: 'failed',
          ragError: message,
        });
        this.logger.error(`Failed to index paper ${item.id}: ${message}`);
      }
    }
  }
}
