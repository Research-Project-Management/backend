import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { CatalogService } from '../../catalog/catalog.service';
import { TransactionService } from '../../sync/services/transaction.service';
import { BibtexParser } from '../parsers/bibtex.parser';
import { IngestionValidationException } from '../errors/ingestion.errors';
import { IngestionCommand, IngestionResult } from '../types/ingestion.types';
import { IngestionStatus, Prisma } from '@prisma/client';
import {
  IIngestionStrategy,
  IngestionExecutionContext,
} from './ingestion-strategy.interface';

@Injectable()
export class BibtexIngestionStrategy implements IIngestionStrategy<
  IngestionCommand & { source: 'bibtex' }
> {
  readonly source = 'bibtex';
  private readonly logger = new Logger(BibtexIngestionStrategy.name);

  constructor(
    private readonly bibtexParserService: BibtexParser,
    @Optional()
    @Inject(CatalogService)
    private readonly catalogService?: CatalogService,
    @Optional()
    @Inject(TransactionService)
    private readonly libraryTx?: TransactionService,
  ) {}

  canHandle(source: string): boolean {
    return source === 'bibtex';
  }

  async execute(
    command: IngestionCommand & { source: 'bibtex' },
    context: IngestionExecutionContext,
  ): Promise<IngestionResult> {
    const { workspaceId, runId, requestHash } = context;

    if (command.content && command.content.length > 10 * 1024 * 1024) {
      throw new IngestionValidationException(
        'BibTeX payload exceeds 10MB limit',
      );
    }

    const entries = this.bibtexParserService.parse(command.content);
    const first = entries[0] || { title: 'BibTeX Item' };

    let createdItem: any = null;
    const bibItemData: any = {
      title: first.title,
      doi: first.doi,
      year: first.year,
      authors: first.authors || [],
      journal: first.journal,
      publicationTitle: first.journal || first.publisher,
      publisher: first.publisher,
      volume: first.volume,
      issue: first.issue,
      pages: first.pages,
      isbn: first.isbn,
      issn: first.issn,
      url: first.url,
      citationKey: first.citationKey,
      abstract: first.abstract,
      labels: first.keywords || [],
      keywords: first.keywords || [],
      notes: first.notes,
      language: first.language,
      rights: first.rights,
      fileUrl: first.fileUrl,
      uploadedById: command.userId || 'system',
      collectionId: command.collectionId,
      itemType: first.itemType || 'journalArticle',
    };

    if (this.libraryTx?.executeInTransaction) {
      createdItem = await this.libraryTx.executeInTransaction(
        async (tx: Prisma.TransactionClient, helpers: any) => {
          if (this.catalogService?.createItem) {
            return await this.catalogService.createItem(
              workspaceId,
              bibItemData,
              {
                tx,
                helpers,
                source: 'bibtex',
              },
            );
          }
          throw new Error('CatalogService is required to create BibTeX item');
        },
      );
    } else if (this.catalogService?.createItem) {
      createdItem = await this.catalogService.createItem(
        workspaceId,
        bibItemData,
        {
          source: 'bibtex',
        },
      );
    }

    const result: IngestionResult = {
      runId,
      status: 'completed',
      itemId: createdItem?.id,
      attachmentIds: [],
      deduplicated: false,
      item: createdItem,
    };

    await context.saveIdempotency(
      workspaceId,
      command.idempotencyKey,
      requestHash,
      result,
    );
    await context.updateRunStatus(workspaceId, runId, IngestionStatus.READY, {
      itemId: result.itemId,
      completedAt: new Date(),
    });

    return result;
  }
}
