import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { CatalogService } from '../../catalog/catalog.service';
import { TransactionService } from '../../sync/services/transaction.service';
import { UrlCaptureProvider } from '../providers/url-capture.provider';
import { MetadataRoutingPolicy } from '../metadata/policies/metadata.policy';
import { IngestionValidationException } from '../errors/ingestion.errors';
import { IngestionCommand, IngestionResult } from '../types/ingestion.types';
import { IngestionStatus, Prisma } from '@prisma/client';
import {
  IIngestionStrategy,
  IngestionExecutionContext,
} from './ingestion-strategy.interface';

@Injectable()
export class UrlIngestionStrategy implements IIngestionStrategy<
  IngestionCommand & { source: 'url' }
> {
  readonly source = 'url';
  private readonly logger = new Logger(UrlIngestionStrategy.name);

  constructor(
    @Optional()
    @Inject(UrlCaptureProvider)
    private readonly urlConnector?: UrlCaptureProvider,
    @Optional()
    @Inject(CatalogService)
    private readonly catalogService?: CatalogService,
    @Optional()
    @Inject(TransactionService)
    private readonly libraryTx?: TransactionService,
  ) {}

  canHandle(source: string): boolean {
    return source === 'url';
  }

  async execute(
    command: IngestionCommand & { source: 'url' },
    context: IngestionExecutionContext,
  ): Promise<IngestionResult> {
    const { workspaceId, runId, requestHash } = context;

    try {
      MetadataRoutingPolicy.validateUrl(command.url);
    } catch (err: any) {
      throw new IngestionValidationException(
        `SSRF violation: ${err?.message || err}`,
      );
    }

    let captured: any = null;
    if (this.urlConnector?.captureFromUrl) {
      try {
        captured = await this.urlConnector.captureFromUrl(command.url, {
          workspaceId,
        });
      } catch {
        captured = {
          title: command.overrides?.title || 'Web Page',
          url: command.url,
          itemType: 'webpage',
        };
      }
    }

    const rawTags = command.overrides?.tags || captured?.keywords || [];
    const urlItemData: any = {
      title: command.overrides?.title || captured?.title || 'Web Page',
      abstract: command.overrides?.abstract || captured?.abstract,
      url: command.url,
      fileUrl: command.url,
      authors: captured?.authors || [],
      doi: captured?.doi,
      year: captured?.year,
      publicationTitle: captured?.publicationTitle || captured?.journal,
      publisher: captured?.publisher,
      volume: captured?.volume,
      issue: captured?.issue,
      pages: captured?.pages,
      issn: captured?.issn,
      isbn: captured?.isbn,
      language: captured?.language,
      rights: captured?.rights,
      license: captured?.license,
      extra: captured?.extra,
      citationKey: captured?.citationKey,
      labels: rawTags,
      keywords: rawTags,
      uploadedById: command.userId || 'system',
      collectionId: command.collectionId,
      itemType: captured?.itemType || 'webpage',
    };

    let createdItem: any = null;
    if (this.libraryTx?.executeInTransaction) {
      createdItem = await this.libraryTx.executeInTransaction(
        async (tx: Prisma.TransactionClient, helpers: any) => {
          if (this.catalogService?.createItem) {
            return await this.catalogService.createItem(
              workspaceId,
              urlItemData,
              {
                tx,
                helpers,
                source: 'url',
              },
            );
          }
          throw new Error('CatalogService is required to create URL item');
        },
      );
    } else if (this.catalogService?.createItem) {
      createdItem = await this.catalogService.createItem(
        workspaceId,
        urlItemData,
        {
          source: 'url',
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
