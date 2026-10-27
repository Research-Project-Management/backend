import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  Inject,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RedisCacheService } from '@/core';
import {
  TransactionHelpers,
  LIBRARY_EVENT_TYPES,
  LIBRARY_REDIS_KEYS,
  CATALOG_FACADE,
  ICatalogFacade,
  EXTRACTION_FACADE,
  IExtractionFacade,
  normalizeDoi,
  normalizeProjectScopeId,
} from '@/modules/library/core';
import { TransactionService } from '@/modules/library/sync';
import { IngestionRepository } from '@/modules/library/ingestion/repositories/ingestion.repository';
import { MergeDuplicatesDto } from '@/modules/library/ingestion/dto/curation.dto';
import { PrismaMergeAuditTrail } from '@/modules/library/ingestion/types/curation.types';
import {
  invalidateMergedItemsCache,
  recordMergedAssetSyncEventsInTx,
  softDeleteDuplicatesAndRecordOutboxInTx,
} from '@/modules/library/ingestion/domain/duplicate-merge.helper';
import { UserId, ProjectId } from '@/modules/library/core/types/branded.types';
import { asMetaObject } from './duplicate-detector.service';
import { IStoragePort, STORAGE_PORT } from '@/modules/storage/storage.port';
import { deriveFirstAuthor } from '@/modules/library/catalog/catalog.facade';

import {
  ContributorShape,
  SYSTEM_RESERVED_MERGE_KEYS,
  TOP_LEVEL_ITEM_COLUMNS,
  IDENTIFIER_META_KEYS,
  RETRACTION_SURVIVAL_KEYS,
  rewireMergedItemRelations,
  consolidateUserPublications,
  syncMergedIdentifiersInTx,
  applyMergedUpdatesAndClearDuplicateCitationKeyCollision,
} from '@/modules/library/ingestion/domain/duplicate-merge.domain';
import {
  AuditSnapshotBuilder,
  DuplicateMergeStepContext,
  executeDuplicateMergePipeline,
} from '@/modules/library/ingestion/domain/duplicate-merge.steps';
import {
  DuplicateMergeMemento,
  MasterPreMergeSnapshot,
  MergedDuplicateSnapshot,
  capturePreMergeRelationsInTx,
  attachCapturedMergeStepRelations,
  createDuplicateMergeMemento,
  serializeMergeMemento,
  parseMergeMemento,
  buildMasterRestoreData,
  recordMergeMementoInTx,
  executeUndoDuplicateMergeInTx,
} from '@/modules/library/ingestion/domain/duplicate-merge.memento';
import { ItemsMapper, ItemCacheCoordinator } from '@/modules/library/catalog';

export type {
  ContributorShape,
  DuplicateMergeMemento,
  MasterPreMergeSnapshot,
  MergedDuplicateSnapshot,
};
export {
  SYSTEM_RESERVED_MERGE_KEYS,
  TOP_LEVEL_ITEM_COLUMNS,
  IDENTIFIER_META_KEYS,
  RETRACTION_SURVIVAL_KEYS,
  createDuplicateMergeMemento,
  serializeMergeMemento,
  parseMergeMemento,
  buildMasterRestoreData,
};

@Injectable()
export class DuplicateMergerService {
  private readonly logger = new Logger(DuplicateMergerService.name);

  constructor(
    private readonly libraryTx: TransactionService,
    @Optional()
    @Inject(CATALOG_FACADE)
    private readonly catalogGateway?: ICatalogFacade,
    @Optional()
    @Inject(EXTRACTION_FACADE)
    private readonly extractionGateway?: IExtractionFacade,
    @Optional()
    private readonly ingestionRepo?: IngestionRepository,
    @Optional()
    @Inject(STORAGE_PORT)
    private readonly storagePort?: IStoragePort,
    @Optional()
    private readonly cache?: RedisCacheService,
    @Optional()
    private readonly cacheCoordinator?: ItemCacheCoordinator,
  ) {}

  async mergeDuplicates(
    userId: UserId | string,
    dto: MergeDuplicatesDto,
    projectId?: ProjectId | string,
  ) {
    if (!dto.primaryItemId) {
      throw new BadRequestException('primaryItemId is required');
    }
    if (!dto.duplicateItemIds || dto.duplicateItemIds.length === 0) {
      throw new BadRequestException('duplicateItemIds must not be empty');
    }

    const uniqueDupIds = Array.from(new Set(dto.duplicateItemIds));
    if (uniqueDupIds.includes(dto.primaryItemId)) {
      throw new BadRequestException(
        'primaryItemId cannot be included in duplicateItemIds',
      );
    }

    if (dto.fieldSelections) {
      for (const field of Object.keys(dto.fieldSelections)) {
        if (SYSTEM_RESERVED_MERGE_KEYS.has(field)) {
          throw new BadRequestException(
            `Field "${field}" is a system-reserved key and is not allowed in merge fieldSelections`,
          );
        }
      }
    }

    const effectiveProjectId = normalizeProjectScopeId(
      projectId || dto.projectId,
    );
    const allItemIds = [dto.primaryItemId, ...uniqueDupIds];
    const items = this.catalogGateway
      ? await this.catalogGateway.findByIds(
          userId,
          allItemIds,
          effectiveProjectId,
        )
      : [];

    if (items.length !== allItemIds.length) {
      throw new NotFoundException(
        'One or more items do not exist, are already deleted, or belong to another user',
      );
    }

    for (const item of items) {
      if ('projectId' in item) {
        const itemProjectId = normalizeProjectScopeId(
          (item as { projectId?: string | null }).projectId,
        );
        if (itemProjectId !== effectiveProjectId) {
          throw new BadRequestException(
            'Cannot merge items across different library scopes (Personal vs Project or different Projects)',
          );
        }
      }
    }

    const primary = items.find((it) => it.id === dto.primaryItemId)!;
    const duplicates = items.filter((it) => it.id !== dto.primaryItemId);

    const selectedTargetType =
      typeof dto.fieldSelections?.itemType === 'string' &&
      dto.fieldSelections.itemType.trim().length > 0
        ? dto.fieldSelections.itemType.trim()
        : undefined;
    const effectiveMergedItemType =
      selectedTargetType ||
      primary.itemType ||
      primary.type ||
      'journalArticle';

    const offloadedFileIdsToDelete: string[] = [];
    const reassignedOrphanFileIds: string[] = [];

    const txResult = await this.libraryTx.executeInTransaction(
      async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
        const now = new Date();

        try {
          const sortedLockIds = [primary.id, ...uniqueDupIds].slice().sort();
          for (const lockTargetId of sortedLockIds) {
            let hash = 0;
            for (let i = 0; i < lockTargetId.length; i++) {
              hash = (hash << 5) - hash + lockTargetId.charCodeAt(i);
              hash |= 0;
            }
            const lockKey = hash & 0x7fffffff;
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey})`;
          }
        } catch (err) {
          this.logger.warn(
            `Could not acquire pg_advisory_xact_lock: ${(err as Error).message}`,
          );
        }

        const eventScope = { userId, projectId: effectiveProjectId };

        const [rawInitialNotes, rawInitialAttachments] = await Promise.all([
          tx.note?.findMany?.({
            where: { itemId: { in: uniqueDupIds } },
            select: { id: true, itemId: true },
          }),
          tx.attachment?.findMany?.({
            where: { itemId: { in: uniqueDupIds } },
            select: { id: true, itemId: true, attachmentType: true },
          }),
        ]);
        const initialNotes = rawInitialNotes || [];
        const initialAttachments = rawInitialAttachments || [];

        const { primaryRelations, duplicateRelationsById } =
          await capturePreMergeRelationsInTx({
            tx,
            primary: primary as Record<string, unknown> & { id: string },
            duplicates: duplicates as Array<
              Record<string, unknown> & { id: string }
            >,
            uniqueDupIds,
            initialNotes,
            initialAttachments,
          });

        if (this.extractionGateway?.reassignContentToItem) {
          const orphaned = await this.extractionGateway.reassignContentToItem(
            uniqueDupIds,
            primary.id,
            tx,
          );
          if (Array.isArray(orphaned) && orphaned.length > 0) {
            reassignedOrphanFileIds.push(...orphaned);
          }
        }

        if (this.catalogGateway) {
          await this.catalogGateway.mergeItems(tx, uniqueDupIds, primary.id);
        }

        await recordMergedAssetSyncEventsInTx({
          tx,
          helpers,
          eventScope: { userId: String(userId), projectId: effectiveProjectId },
          initialNotes,
          initialAttachments,
        });

        const preMergeItemRelations = await rewireMergedItemRelations(
          tx,
          primary.id,
          uniqueDupIds,
        );
        const preMergePubs = await consolidateUserPublications(
          tx,
          primary.id,
          uniqueDupIds,
        );

        const primaryMeta = { ...asMetaObject(primary.metadata) };
        const rawSelections = dto.fieldSelections || {};
        const {
          authors: _selectedAuthors,
          creators: _selectedCreators,
          contributors: _selectedContributors,
          ...scalarSelections
        } = rawSelections;
        const backfillFields: Record<string, unknown> = {};

        const pipelineCtx: DuplicateMergeStepContext = {
          tx,
          primary: primary as Record<string, unknown> & {
            id: string;
            citationKey?: string | null;
            metadata?: unknown;
          },
          duplicates: duplicates as Array<
            Record<string, unknown> & {
              id: string;
              citationKey?: string | null;
              doi?: string | null;
              metadata?: unknown;
              contributors?: unknown;
            }
          >,
          uniqueDupIds,
          rawSelections,
          scalarSelections,
          primaryMeta,
          backfillFields,
          offloadedFileIdsToDelete,
          now,
        };
        await executeDuplicateMergePipeline(pipelineCtx);
        attachCapturedMergeStepRelations({
          primaryId: primary.id,
          duplicates,
          primaryRelations,
          duplicateRelationsById,
          preMergeItemRelations,
          preMergePubs,
          capturedPrimaryItemMetadata: pipelineCtx.capturedPrimaryItemMetadata,
          capturedDuplicateItemMetadata: pipelineCtx.capturedDuplicateItemMetadata,
        });

        const primaryContributors =
          pipelineCtx.syncedContributors ??
          (await tx.contributor?.findMany?.({
            where: { itemId: primary.id },
            orderBy: { orderIndex: 'asc' },
          })) ??
          (primary as { contributors?: Array<Record<string, unknown>> })
            .contributors ??
          [];
        const derivedFirstAuthor = deriveFirstAuthor({
          contributors: primaryContributors,
          creators: Array.isArray(primaryMeta.creators)
            ? (primaryMeta.creators as Array<Record<string, unknown>>)
            : undefined,
          authors: Array.isArray(primaryMeta.authors)
            ? (primaryMeta.authors as Array<string | Record<string, unknown>>)
            : undefined,
        });

        const [noteCount, attachmentCount] = await Promise.all([
          tx.note?.count ? tx.note.count({
            where: { itemId: primary.id, deletedAt: null },
          }) : Promise.resolve(undefined),
          tx.attachment?.count ? tx.attachment.count({
            where: { itemId: primary.id, deletedAt: null },
          }) : Promise.resolve(undefined),
        ]);

        const { topLevelData } =
          await applyMergedUpdatesAndClearDuplicateCitationKeyCollision({
            tx,
            primary: primary as Record<string, unknown>,
            duplicates: duplicates as Array<Record<string, unknown>>,
            effectiveMergedItemType,
            derivedFirstAuthor,
            noteCount,
            attachmentCount,
            backfillFields,
            scalarSelections,
            primaryMeta,
          });

        await syncMergedIdentifiersInTx({
          tx,
          primaryId: primary.id,
          uniqueDupIds,
          primaryMeta,
          topLevelData,
          primaryDoi: primary.doi,
        });

        const mergeMemento = createDuplicateMergeMemento({
          primary: primary as Record<string, unknown> & { id: string },
          duplicates: duplicates as Array<
            Record<string, unknown> & { id: string }
          >,
          uniqueDupIds,
          mergedMetadataFields: Object.keys(backfillFields),
          reassignedNoteIds: initialNotes.map((n) => n.id),
          reassignedAttachmentIds: initialAttachments.map((a) => a.id),
          mergedCreatorCount: Array.isArray(primaryContributors)
            ? primaryContributors.length
            : 0,
          primaryRelations,
          duplicateRelationsById,
          now,
        });
        await recordMergeMementoInTx({
          tx,
          userId: String(userId),
          projectId: effectiveProjectId,
          primaryId: primary.id,
          primaryMeta,
          memento: mergeMemento,
        });

        const updatedPrimary = await tx.item.update({
          where: { id: primary.id },
          data: {
            ...topLevelData,
            metadata: primaryMeta as Prisma.InputJsonValue,
            version: { increment: 1 },
          },
        });

        await helpers.publishOutbox(
          eventScope,
          primary.id,
          LIBRARY_EVENT_TYPES.ITEM_MERGED,
          {
            primaryItemId: primary.id,
            duplicateItemIds: uniqueDupIds,
            mergedCount: duplicates.length,
            mergedAt: now.toISOString(),
            projectId: effectiveProjectId,
          },
        );

        await softDeleteDuplicatesAndRecordOutboxInTx({
          tx,
          helpers,
          eventScope: { userId: String(userId), projectId: effectiveProjectId },
          primaryId: primary.id,
          duplicates: duplicates as Array<{ id: string; metadata?: unknown }>,
          userId: String(userId),
          effectiveProjectId,
          now,
        });

        if (this.ingestionRepo) {
          try {
            await this.ingestionRepo.resolveReviewCasesForItems(allItemIds, tx);
          } catch (err) {
            this.logger.warn(
              `Could not resolve ingestion review cases: ${(err as Error).message}`,
            );
          }
        }

        const reloadedPrimary = await tx.item.findUnique({
          where: { id: primary.id },
          include: {
            contributors: { orderBy: { orderIndex: 'asc' } },
            collectionItems: { include: { collection: true } },
            itemTags: { include: { tag: true } },
            notesList: { where: { deletedAt: null } },
            attachments: { include: { revisions: true } },
          },
        });

        const finalPrimary = reloadedPrimary ?? updatedPrimary;
        await helpers.appendChange(eventScope, {
          entityType: 'Item',
          entityId: primary.id,
          action: 'update',
          version: updatedPrimary.version,
          data: ItemsMapper.toDomain(
            finalPrimary as unknown as Parameters<typeof ItemsMapper.toDomain>[0],
          ),
        });
        const audit: PrismaMergeAuditTrail = AuditSnapshotBuilder.build({
          primary,
          duplicates,
          uniqueDupIds,
          finalPrimary,
          primaryMeta,
          backfillFields,
          now,
        });

        return {
          primaryItem: finalPrimary,
          mergedCount: duplicates.length,
          softDeletedItemIds: uniqueDupIds,
          audit,
        };
      },
    );

    if (reassignedOrphanFileIds.length > 0) {
      if (this.extractionGateway?.cleanupOrphanedFiles) {
        await this.extractionGateway.cleanupOrphanedFiles(
          reassignedOrphanFileIds,
        );
      } else if (this.storagePort?.deleteFile) {
        for (const fid of reassignedOrphanFileIds) {
          try {
            await this.storagePort.deleteFile(fid);
          } catch (delErr: unknown) {
            const msg =
              delErr instanceof Error ? delErr.message : String(delErr);
            this.logger.warn(
              `Failed to delete duplicate attachment file ${fid} on item merge: ${msg}`,
            );
          }
        }
      }
    }

    // Retain offloadedFileIdsToDelete blobs in storagePort so undoMerge can restore ItemMetadata Claim Check payloads intact.

    if (this.cacheCoordinator) {
      await this.cacheCoordinator.invalidateForWrite({
        userId: String(userId),
        projectId: effectiveProjectId,
        itemIds: [primary.id, ...uniqueDupIds],
      });
    } else {
      await invalidateMergedItemsCache({
        cache: this.cache,
        logger: this.logger,
        primaryId: primary.id,
        uniqueDupIds,
        userId: String(userId),
        effectiveProjectId,
      });
    }

    return txResult;
  }

  /**
   * Reverses a prior duplicate merge using the GoF Memento pattern (`DuplicateMergeMemento`).
   * Restores soft-deleted duplicate items (`deletedAt: null`), rolls back the master item's
   * pre-merge scalar fields and metadata from `memento.beforeMaster`, and emits sync/outbox events.
   */
  async undoMerge(
    userId: UserId | string,
    primaryItemId: string,
    scope?: { userId?: string; projectId?: string | null } | string,
  ): Promise<{ restoredPrimaryId: string; restoredDuplicateIds: string[] }> {
    if (!primaryItemId || !primaryItemId.trim()) {
      throw new BadRequestException('primaryItemId is required to undo merge');
    }

    const rawProjectId =
      typeof scope === 'object' && scope !== null ? scope.projectId : scope;
    const effectiveProjectId = normalizeProjectScopeId(rawProjectId);

    const result = await this.libraryTx.executeInTransaction(
      async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) =>
        executeUndoDuplicateMergeInTx({
          tx,
          helpers,
          userId: String(userId),
          primaryItemId,
          effectiveProjectId,
        }),
    );

    if (this.cacheCoordinator) {
      await this.cacheCoordinator.invalidateForWrite({
        userId: String(userId),
        projectId: effectiveProjectId,
        itemIds: [result.restoredPrimaryId, ...result.restoredDuplicateIds],
      });
    } else {
      await invalidateMergedItemsCache({
        cache: this.cache,
        logger: this.logger,
        primaryId: result.restoredPrimaryId,
        uniqueDupIds: result.restoredDuplicateIds,
        userId: String(userId),
        effectiveProjectId,
      });
    }

    return result;
  }
}
