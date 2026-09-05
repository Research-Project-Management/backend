import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { CatalogService } from '../../items/items.service';
import { TransactionService } from '../../outbox/transaction.service';
import { BibtexParser } from '../parsers/bibtex.parser';
import { IngestionValidationException } from '../errors/ingestion.errors';
import { toCatalogItemData } from '../stages/commit.stage';
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
    if (!entries || entries.length === 0) {
      throw new IngestionValidationException(
        'No valid BibTeX entries found in content',
      );
    }

    const createdItems: any[] = [];

    if (this.libraryTx?.executeInTransaction) {
      await this.libraryTx.executeInTransaction(
        async (tx: Prisma.TransactionClient, helpers: any) => {
          if (!this.catalogService?.createItem) {
            throw new Error('CatalogService is required to create BibTeX item');
          }
          for (const entry of entries) {
            const bibItemData: any = {
              title: entry.title || 'BibTeX Item',
              doi: entry.doi,
              year: entry.year,
              authors: entry.authors || [],
              journal: entry.journal,
              publicationTitle: entry.journal || entry.publisher,
              publisher: entry.publisher,
              volume: entry.volume,
              issue: entry.issue,
              pages: entry.pages,
              isbn: entry.isbn,
              issn: entry.issn,
              url: entry.url,
              citationKey: entry.citationKey,
              abstract: entry.abstract,
              labels: entry.keywords || [],
              keywords: entry.keywords || [],
              notes: entry.notes,
              language: entry.language,
              rights: entry.rights,
              fileUrl: entry.fileUrl,
              uploadedById: command.userId || 'system',
              collectionId: command.collectionId,
              itemType: entry.itemType || 'journalArticle',
            };
            const createItemData = toCatalogItemData(
              {
                ...entry,
                ...((command as any).overrides || {}),
                ...bibItemData,
              },
              {
                collectionIds: command.collectionId
                  ? [command.collectionId]
                  : [],
                userId: command.userId,
              },
            );
            const item = await this.catalogService.createItem(
              workspaceId,
              createItemData,
              {
                tx,
                helpers,
                source: 'bibtex',
              },
            );
            createdItems.push(item);
          }
        },
      );
    } else if (this.catalogService?.createItem) {
      for (const entry of entries) {
        const bibItemData: any = {
          title: entry.title || 'BibTeX Item',
          doi: entry.doi,
          year: entry.year,
          authors: entry.authors || [],
          journal: entry.journal,
          publicationTitle: entry.journal || entry.publisher,
          publisher: entry.publisher,
          volume: entry.volume,
          issue: entry.issue,
          pages: entry.pages,
          isbn: entry.isbn,
          issn: entry.issn,
          url: entry.url,
          citationKey: entry.citationKey,
          abstract: entry.abstract,
          labels: entry.keywords || [],
          keywords: entry.keywords || [],
          notes: entry.notes,
          language: entry.language,
          rights: entry.rights,
          fileUrl: entry.fileUrl,
          uploadedById: command.userId || 'system',
          collectionId: command.collectionId,
          itemType: entry.itemType || 'journalArticle',
        };
        const createItemData = toCatalogItemData(
          {
            ...entry,
            ...((command as any).overrides || {}),
            ...bibItemData,
          },
          {
            collectionIds: command.collectionId
              ? [command.collectionId]
              : [],
            userId: command.userId,
          },
        );
        const item = await this.catalogService.createItem(
          workspaceId,
          createItemData,
          {
            source: 'bibtex',
          },
        );
        createdItems.push(item);
      }
    }

    const firstCreated = createdItems[0] || null;

    const result: IngestionResult = {
      runId,
      status: 'completed',
      itemId: firstCreated?.id,
      attachmentIds: [],
      deduplicated: false,
      item: firstCreated,
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
