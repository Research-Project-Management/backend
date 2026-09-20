import {
  Injectable,
  NotFoundException,
  Optional,
  Logger,
} from '@nestjs/common';
import { RagStatus } from '@prisma/client';
import { QueryRepository } from '../../../infrastructure/repositories/query.repository';
import { CommandRepository } from '../../../infrastructure/repositories/command.repository';
import { RagProvider } from '../../../../discovery/infrastructure/providers/rag.provider';
import { SemanticSearchService } from '../../../../discovery/application/services/semantic-search.service';
import { TransactionService } from '../../../../shared-kernel/outbox/transaction.service';

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
 * Triggers re-indexing of a library item into:
 * 1. In-process local semantic vector store (SemanticSearchService — offline, zero API)
 * 2. External Qdrant vector DB (RagProvider — optional)
 *
 * Both indexers are @Optional — graceful degradation when not configured.
 * Indexing is fire-and-forget after publishing an outbox event.
 *
 * Application layer: no HTTP, no route-level concerns.
 */
@Injectable()
export class ReindexItemUseCase {
  private readonly logger = new Logger(ReindexItemUseCase.name);

  constructor(
    private readonly queryRepo: QueryRepository,
    private readonly commandRepo: CommandRepository,
    private readonly libraryTx: TransactionService,
    @Optional() private readonly rag?: RagProvider,
    @Optional() private readonly semanticSearch?: SemanticSearchService,
  ) {}

  async execute(command: ReindexItemCommand): Promise<ReindexItemResult> {
    const item = await this.queryRepo.findById(
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
    await this.commandRepo.updateRagStatus(item.id, {
      ragStatus: RagStatus.pending,
      ragLastAttemptAt: new Date(),
    });

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
      await this.commandRepo.updateRagStatus(item.id, {
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
        await this.commandRepo.updateRagStatus(item.id, {
          ragStatus: 'indexed',
          ragIndexedAt: new Date(),
        });
        this.logger.log(
          `Paper ${item.id} indexed into local vector store (external Qdrant offline).`,
        );
      } else {
        await this.commandRepo.updateRagStatus(item.id, {
          ragStatus: 'failed',
          ragError: message,
        });
        this.logger.error(`Failed to index paper ${item.id}: ${message}`);
      }
    }
  }
}
