import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { PrismaService } from '../../../../core/database/prisma.service';
import { DoiParser } from '../parsers/doi.parser';
import { METADATA_PORT, MetadataPort } from '../metadata/types/metadata.types';
import { CatalogService } from '../../items/items.service';
import { TransactionService } from '../../outbox/transaction.service';
import { CatalogItemMapper } from '../../items/items.mapper';
import { toCatalogItemData } from '../stages/commit.stage';
import { IngestionCommand, IngestionResult } from '../types/ingestion.types';
import { IngestionStatus, Prisma } from '@prisma/client';
import {
  IIngestionStrategy,
  IngestionExecutionContext,
} from './ingestion-strategy.interface';

@Injectable()
export class DoiIngestionStrategy implements IIngestionStrategy<
  IngestionCommand & { source: 'doi' }
> {
  readonly source = 'doi';
  private readonly logger = new Logger(DoiIngestionStrategy.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly doiParser: DoiParser,
    @Optional()
    @Inject(METADATA_PORT)
    private readonly metadataPort?: MetadataPort,
    @Optional()
    @Inject(CatalogService)
    private readonly catalogService?: CatalogService,
    @Optional()
    @Inject(TransactionService)
    private readonly libraryTx?: TransactionService,
  ) {}

  canHandle(source: string): boolean {
    return source === 'doi';
  }

  async execute(
    command: IngestionCommand & { source: 'doi' },
    context: IngestionExecutionContext,
  ): Promise<IngestionResult> {
    const { workspaceId, runId, requestHash } = context;
    const cleanDoi = this.doiParser.isValid(command.doi)
      ? this.doiParser.normalize(command.doi)
      : command.doi.toLowerCase().trim();

    return await context.withKeyLock(
      `${workspaceId}:doi:${cleanDoi}`,
      async () => {
        // 1. Check dedup claim
        const claim = await this.prisma.libraryDedupClaim.findUnique({
          where: {
            workspaceId_claimType_claimValue: {
              workspaceId,
              claimType: 'doi',
              claimValue: cleanDoi,
            },
          },
          include: {
            catalogItem: true,
          },
        });

        if (claim?.catalogItem) {
          if (claim.catalogItem.deletedAt) {
            const restored = await this.prisma.catalogItem.update({
              where: { id: claim.catalogItem.id },
              data: { deletedAt: null },
            });
            const result: IngestionResult = {
              runId,
              status: 'completed',
              itemId: restored.id,
              attachmentIds: [],
              deduplicated: true,
              item: restored,
            };
            await context.saveIdempotency(
              workspaceId,
              command.idempotencyKey,
              requestHash,
              result,
            );
            await context.updateRunStatus(
              workspaceId,
              runId,
              IngestionStatus.READY,
              { itemId: restored.id, completedAt: new Date() },
            );
            return result;
          }

          const result: IngestionResult = {
            runId,
            status: 'completed',
            itemId: claim.catalogItem.id,
            attachmentIds: [],
            deduplicated: true,
            item: claim.catalogItem,
          };
          await context.saveIdempotency(
            workspaceId,
            command.idempotencyKey,
            requestHash,
            result,
          );
          await context.updateRunStatus(
            workspaceId,
            runId,
            IngestionStatus.READY,
            { itemId: claim.catalogItem.id, completedAt: new Date() },
          );
          return result;
        }

        // 2. Check existing item in database
        const existing = await this.prisma.catalogItem.findFirst({
          where: {
            workspaceId,
            doi: { equals: cleanDoi, mode: 'insensitive' },
          },
        });

        if (existing) {
          if (existing.deletedAt) {
            const restored = await this.prisma.catalogItem.update({
              where: { id: existing.id },
              data: { deletedAt: null },
            });

            await this.prisma.libraryDedupClaim
              .upsert({
                where: {
                  workspaceId_claimType_claimValue: {
                    workspaceId,
                    claimType: 'doi',
                    claimValue: cleanDoi,
                  },
                },
                update: { catalogItemId: restored.id },
                create: {
                  workspaceId,
                  claimType: 'doi',
                  claimValue: cleanDoi,
                  catalogItemId: restored.id,
                },
              })
              .catch((err) => {
                this.logger.warn(
                  `Failed to upsert dedup claim for doi ${cleanDoi}: ${err?.message}`,
                );
              });

            const result: IngestionResult = {
              runId,
              status: 'completed',
              itemId: restored.id,
              attachmentIds: [],
              deduplicated: true,
              item: restored,
            };
            await context.saveIdempotency(
              workspaceId,
              command.idempotencyKey,
              requestHash,
              result,
            );
            await context.updateRunStatus(
              workspaceId,
              runId,
              IngestionStatus.READY,
              { itemId: restored.id, completedAt: new Date() },
            );
            return result;
          }

          await this.prisma.libraryDedupClaim
            .upsert({
              where: {
                workspaceId_claimType_claimValue: {
                  workspaceId,
                  claimType: 'doi',
                  claimValue: cleanDoi,
                },
              },
              update: { catalogItemId: existing.id },
              create: {
                workspaceId,
                claimType: 'doi',
                claimValue: cleanDoi,
                catalogItemId: existing.id,
              },
            })
            .catch((err) => {
              this.logger.warn(
                `Failed to upsert dedup claim for existing DOI item: ${err?.message}`,
              );
            });

          const result: IngestionResult = {
            runId,
            status: 'completed',
            itemId: existing.id,
            attachmentIds: [],
            deduplicated: true,
            item: existing,
          };
          await context.saveIdempotency(
            workspaceId,
            command.idempotencyKey,
            requestHash,
            result,
          );
          await context.updateRunStatus(
            workspaceId,
            runId,
            IngestionStatus.READY,
            { itemId: existing.id, completedAt: new Date() },
          );
          return result;
        }

        // 3. Resolve via metadata service
        let resolvedMeta: any = null;
        if (this.metadataPort?.resolve) {
          resolvedMeta = await this.metadataPort.resolve({
            query: cleanDoi,
            workspaceId,
          });
        }

        const meta = resolvedMeta?.metadata ||
          resolvedMeta || { title: 'Imported DOI Document', doi: cleanDoi };

        let createdItem: any = null;
        let isDedup = false;
        const itemData: any = {
          title: command.overrides?.title || meta.title || 'Untitled Document',
          doi: cleanDoi,
          arxivId: meta.arxivId || '',
          pmid: command.overrides?.pmid || meta.pmid || '',
          pmcid: command.overrides?.pmcid || meta.pmcid || '',
          issn: command.overrides?.issn || meta.issn || '',
          isbn: command.overrides?.isbn || meta.isbn || '',
          year: command.overrides?.year || meta.year || null,
          publicationDate:
            command.overrides?.publicationDate ||
            meta.publicationDate ||
            (meta.year ? String(meta.year) : ''),
          authors: command.overrides?.authors || meta.authors || [],
          creators: meta.creators || undefined,
          abstract: command.overrides?.abstract || meta.abstract || '',
          publicationTitle:
            command.overrides?.publicationTitle ||
            meta.publicationTitle ||
            meta.journal ||
            '',
          journal:
            command.overrides?.journal ||
            meta.journal ||
            meta.publicationTitle ||
            '',
          publisher: command.overrides?.publisher || meta.publisher || '',
          place: command.overrides?.place || meta.place || '',
          volume: command.overrides?.volume || meta.volume || '',
          issue: command.overrides?.issue || meta.issue || '',
          pages: command.overrides?.pages || meta.pages || '',
          series: command.overrides?.series || meta.series || '',
          seriesTitle: command.overrides?.seriesTitle || meta.seriesTitle || '',
          seriesText: command.overrides?.seriesText || meta.seriesText || '',
          journalAbbr:
            command.overrides?.journalAbbr ||
            meta.journalAbbr ||
            meta.journalAbbreviation ||
            '',
          citationKey: command.overrides?.citationKey || meta.citationKey || '',
          shortTitle: command.overrides?.shortTitle || meta.shortTitle || '',
          rights: command.overrides?.rights || meta.rights || '',
          license: command.overrides?.license || meta.license || '',
          language: command.overrides?.language || meta.language || '',
          url:
            command.overrides?.url ||
            meta.url ||
            (cleanDoi ? `https://doi.org/${cleanDoi}` : ''),
          labels:
            command.overrides?.keywords ||
            command.overrides?.tags ||
            meta.keywords ||
            meta.tags ||
            [],
          keywords:
            command.overrides?.keywords ||
            command.overrides?.tags ||
            meta.keywords ||
            meta.tags ||
            [],
          extraFields: {
            ...(meta.extraFields || {}),
            ...(command.overrides?.extraFields || {}),
          },
          uploadedById: command.userId || 'system',
          collectionId: command.collectionId,
          itemType:
            command.overrides?.itemType || meta.itemType || 'journalArticle',
        };
        const createItemData = toCatalogItemData(
          { ...meta, ...(command.overrides || {}), ...itemData },
          {
            collectionIds: command.collectionId ? [command.collectionId] : [],
            userId: command.userId,
          },
        );

        if (this.libraryTx?.executeInTransaction) {
          createdItem = await this.libraryTx.executeInTransaction(
            async (tx: Prisma.TransactionClient, helpers: any) => {
              // Check race condition inside tx
              const raceClaim = await tx.libraryDedupClaim.findUnique({
                where: {
                  workspaceId_claimType_claimValue: {
                    workspaceId,
                    claimType: 'doi',
                    claimValue: cleanDoi,
                  },
                },
                include: { catalogItem: true },
              });
              if (raceClaim?.catalogItem) {
                isDedup = true;
                return raceClaim.catalogItem;
              }

              let item: any;
              if (this.catalogService?.createItem) {
                item = await this.catalogService.createItem(
                  workspaceId,
                  createItemData,
                  {
                    tx,
                    helpers,
                    source: 'doi',
                  },
                );
              } else {
                throw new Error(
                  'CatalogService is required to create DOI item',
                );
              }

              await tx.libraryDedupClaim.create({
                data: {
                  workspaceId,
                  claimType: 'doi',
                  claimValue: cleanDoi,
                  catalogItemId: item.id,
                },
              });

              return item;
            },
          );
        } else if (this.catalogService?.createItem) {
          createdItem = await this.catalogService.createItem(
            workspaceId,
            createItemData,
            {
              source: 'doi',
            },
          );
        }

        const result: IngestionResult = {
          runId,
          status: 'completed',
          itemId: createdItem?.id,
          attachmentIds: [],
          deduplicated: isDedup,
          item: createdItem,
        };

        await context.saveIdempotency(
          workspaceId,
          command.idempotencyKey,
          requestHash,
          result,
        );
        await context.updateRunStatus(
          workspaceId,
          runId,
          IngestionStatus.READY,
          { itemId: result.itemId, completedAt: new Date() },
        );

        return result;
      },
    );
  }
}
