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
import { TransactionHelpers, LIBRARY_EVENT_TYPES, CATALOG_FACADE, ICatalogFacade, ITEM_CACHE_INVALIDATOR, IItemCacheInvalidator, EXTRACTION_FACADE, IExtractionFacade, normalizeProjectScopeId, deriveFirstAuthor, UNIT_OF_WORK, IUnitOfWork, ItemsMapper } from '@/modules/library/core';
import { IngestionRepository } from '@/modules/library/ingestion/repositories/ingestion.repository';
import { MergeDuplicatesDto } from '@/modules/library/ingestion/dto/ingestion.dto';
import { PrismaMergeAuditTrail } from '@/modules/library/ingestion/types/ingestion.types';
import { UserId, ProjectId } from '@/modules/library/core';
import { asMetaObject } from '@/modules/library/ingestion/domain/duplicate-clustering.domain';
import { IStoragePort, STORAGE_PORT } from '@/modules/storage/storage.port';

import {
  ContributorShape,
  SYSTEM_RESERVED_MERGE_KEYS,
  TOP_LEVEL_ITEM_COLUMNS,
  IDENTIFIER_META_KEYS,
  RETRACTION_SURVIVAL_KEYS,
  buildMergeAuditTrail,
} from '@/modules/library/ingestion/domain/duplicate-merge.domain';
import {
  DuplicateMergeStepContext,
  rewireMergedItemRelations,
  consolidateUserPublications,
  syncMergedIdentifiersInTx,
  applyMergedUpdatesAndClearDuplicateCitationKeyCollision,
  invalidateMergedItemsCache,
  executeDuplicateMergePipeline,
  recordMergedAssetSyncEventsInTx,
  softDeleteDuplicatesAndRecordOutboxInTx,
  updateAndReloadMergedPrimaryInTx,
} from '@/modules/library/ingestion/repositories/duplicate-merge.repository';
import { RetractionBloomFilter } from '@/modules/library/ingestion/domain/metadata-validation.policy';

export type { ContributorShape };
export {
  SYSTEM_RESERVED_MERGE_KEYS,
  TOP_LEVEL_ITEM_COLUMNS,
  IDENTIFIER_META_KEYS,
  RETRACTION_SURVIVAL_KEYS,
};

@Injectable()
export class DuplicateMergerService {
  private readonly logger = new Logger(DuplicateMergerService.name);

  constructor(
    @Optional() @Inject(UNIT_OF_WORK) private readonly libraryTx: IUnitOfWork,
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
    @Inject(ITEM_CACHE_INVALIDATOR)
    private readonly cacheCoordinator?: IItemCacheInvalidator,
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
      for (const [field, val] of Object.entries(dto.fieldSelections)) {
        if (SYSTEM_RESERVED_MERGE_KEYS.has(field)) {
          throw new BadRequestException(
            `Field "${field}" is a system-reserved key and is not allowed in merge fieldSelections`,
          );
        }
        if (
          field === 'extraFields' &&
          val &&
          typeof val === 'object' &&
          !Array.isArray(val)
        ) {
          for (const efKey of Object.keys(val)) {
            if (SYSTEM_RESERVED_MERGE_KEYS.has(efKey)) {
              throw new BadRequestException(
                `Field "${efKey}" is a system-reserved key and is not allowed in merge fieldSelections`,
              );
            }
          }
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
    let postCommitRegistered = false;

    const txResult = await this.libraryTx.executeInTransaction(
      async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
        const now = new Date();

        try {
          const lockKeys = Array.from(
            new Set(
              [primary.id, ...uniqueDupIds].map((lockTargetId) =>
                BigInt(
                  (RetractionBloomFilter.fnv1a(lockTargetId) | 0) & 0x7fffffff,
                ),
              ),
            ),
          ).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
          if (lockKeys.length > 0) {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(k) FROM unnest(ARRAY[${Prisma.join(lockKeys)}]::bigint[]) AS k`;
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
        const initialNotes = (rawInitialNotes || []).filter(
          (n): n is { id: string; itemId: string } =>
            typeof n.itemId === 'string',
        );
        const initialAttachments = rawInitialAttachments || [];

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

        const [preMergeItemRelations, preMergePubs] = await Promise.all([
          rewireMergedItemRelations(tx, primary.id, uniqueDupIds),
          consolidateUserPublications(tx, primary.id, uniqueDupIds),
        ]);

        const primaryMeta = { ...asMetaObject(primary.metadata) };
        delete primaryMeta.extraFields;
        delete primaryMeta.metadata;
        const rawSelections = dto.fieldSelections || {};
        const {
          authors: _selectedAuthors,
          creators: _selectedCreators,
          contributors: _selectedContributors,
          extraFields: selectedExtraFields,
          metadata: _selectedMetadata,
          ...topScalarSelections
        } = rawSelections;
        const unpackedExtraSelections: Record<string, unknown> = {};
        if (
          selectedExtraFields &&
          typeof selectedExtraFields === 'object' &&
          !Array.isArray(selectedExtraFields)
        ) {
          for (const [efKey, efVal] of Object.entries(
            selectedExtraFields as Record<string, unknown>,
          )) {
            if (
              !SYSTEM_RESERVED_MERGE_KEYS.has(efKey) &&
              efKey !== 'extraFields' &&
              efKey !== 'metadata' &&
              efKey !== 'authors' &&
              efKey !== 'creators' &&
              efKey !== 'contributors'
            ) {
              unpackedExtraSelections[efKey] = efVal;
            }
          }
        }
        const scalarSelections: Record<string, unknown> = {
          ...unpackedExtraSelections,
          ...topScalarSelections,
        };
        delete scalarSelections.extraFields;
        delete scalarSelections.metadata;
        const backfillFields: Record<string, unknown> = {};

        const pipelineCtx: DuplicateMergeStepContext = {
          tx,
          primary: primary,
          duplicates: duplicates,
          uniqueDupIds,
          rawSelections,
          scalarSelections,
          primaryMeta,
          backfillFields,
          offloadedFileIdsToDelete,
          now,
        };
        await executeDuplicateMergePipeline(pipelineCtx);

        const primaryContributors =
          pipelineCtx.syncedContributors ??
          (await tx.contributor?.findMany?.({
            where: { itemId: primary.id },
            orderBy: { orderIndex: 'asc' },
          })) ??
          (primary as { contributors?: Array<Record<string, unknown>> })
            .contributors ??
          [];

        if (
          Array.isArray(primaryContributors) &&
          primaryContributors.length > 0 &&
          typeof tx.userPublication?.findMany === 'function' &&
          typeof tx.userPublication?.update === 'function'
        ) {
          const userPubs = await tx.userPublication.findMany({
            where: { itemId: primary.id },
          });
          for (const pub of userPubs) {
            const hasValidLink = primaryContributors.some(
              (c) => (c as { id?: string }).id === pub.contributorId,
            );
            if (!hasValidLink) {
              const defaultContribId = (
                primaryContributors[0] as { id?: string }
              )?.id;
              if (defaultContribId) {
                await tx.userPublication.update({
                  where: {
                    userId_itemId: {
                      userId: pub.userId,
                      itemId: pub.itemId,
                    },
                  },
                  data: { contributorId: defaultContribId },
                });
              }
            }
          }
        }

        const derivedFirstAuthor =
          Array.isArray(primaryContributors) &&
          primaryContributors.length === 0 &&
          backfillFields.firstAuthor === null
            ? null
            : deriveFirstAuthor({
                contributors: primaryContributors,
                creators: Array.isArray(primaryMeta.creators)
                  ? (primaryMeta.creators as Array<Record<string, unknown>>)
                  : undefined,
                authors: Array.isArray(primaryMeta.authors)
                  ? (primaryMeta.authors as Array<
                      string | Record<string, unknown>
                    >)
                  : undefined,
                itemType: String(effectiveMergedItemType),
              });

        const needNoteRecount =
          !this.catalogGateway && Boolean(tx.note?.count);
        const needAttachmentRecount =
          !this.extractionGateway?.reassignContentToItem &&
          Boolean(tx.attachment?.count);
        const [noteCount, attachmentCount] =
          needNoteRecount || needAttachmentRecount
            ? await Promise.all([
                needNoteRecount
                  ? tx.note.count({
                      where: { itemId: primary.id, deletedAt: null },
                    })
                  : Promise.resolve(undefined),
                needAttachmentRecount
                  ? tx.attachment.count({
                      where: { itemId: primary.id, deletedAt: null },
                    })
                  : Promise.resolve(undefined),
              ])
            : [undefined, undefined];

        const { topLevelData } =
          await applyMergedUpdatesAndClearDuplicateCitationKeyCollision({
            tx,
            primary: primary,
            duplicates: duplicates,
            effectiveMergedItemType,
            derivedFirstAuthor,
            finalContributors: primaryContributors,
            noteCount,
            attachmentCount,
            backfillFields,
            scalarSelections,
            primaryMeta,
          });

        const explicitlyClearedFields = new Set<string>(
          Object.entries(scalarSelections)
            .filter(
              ([, v]) =>
                v === null || (typeof v === 'string' && v.trim() === ''),
            )
            .map(([k]) => k),
        );

        await syncMergedIdentifiersInTx({
          tx,
          primaryId: primary.id,
          uniqueDupIds,
          primaryMeta,
          topLevelData,
          primaryDoi: primary.doi,
          explicitlyClearedFields,
        });

        const { updatedPrimary, reloadedPrimary } =
          await updateAndReloadMergedPrimaryInTx({
            tx,
            primaryId: primary.id,
            userId: String(userId),
            topLevelData,
            primaryMeta,
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
          duplicates: duplicates,
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

        const finalPrimary = reloadedPrimary ?? updatedPrimary;
        const domainPrimary = ItemsMapper.toDomain(
          finalPrimary,
          String(userId),
        );
        await helpers.appendChange(eventScope, {
          entityType: 'Item',
          entityId: primary.id,
          action: 'update',
          version: updatedPrimary.version,
          data: domainPrimary,
        });
        const audit: PrismaMergeAuditTrail = buildMergeAuditTrail({
          primary,
          duplicates,
          uniqueDupIds,
          finalPrimary,
          primaryMeta,
          backfillFields,
          now,
        });

        if (helpers?.onAfterCommit) {
          postCommitRegistered = true;
          helpers.onAfterCommit(() =>
            invalidateMergedItemsCache({
              cache: this.cache,
              cacheCoordinator: this.cacheCoordinator,
              catalogGateway: this.catalogGateway,
              logger: this.logger,
              primaryId: primary.id,
              uniqueDupIds,
              userId: String(userId),
              effectiveProjectId,
            }),
          );
        }

        return {
          primaryItem: domainPrimary,
          mergedCount: duplicates.length,
          softDeletedItemIds: uniqueDupIds,
          audit,
        };
      },
    );

    if (!postCommitRegistered) {
      await invalidateMergedItemsCache({
        cache: this.cache,
        cacheCoordinator: this.cacheCoordinator,
        catalogGateway: this.catalogGateway,
        logger: this.logger,
        primaryId: primary.id,
        uniqueDupIds,
        userId: String(userId),
        effectiveProjectId,
      });
    }

    const filesToCleanup = Array.from(
      new Set([...reassignedOrphanFileIds, ...offloadedFileIdsToDelete]),
    );
    if (filesToCleanup.length > 0) {
      if (this.extractionGateway?.cleanupOrphanedFiles) {
        await this.extractionGateway.cleanupOrphanedFiles(filesToCleanup);
      } else if (this.storagePort?.deleteFile) {
        for (const fid of filesToCleanup) {
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

    return txResult;
  }

  async mergeDuplicatesBatch(
    userId: UserId | string,
    merges: MergeDuplicatesDto[],
    projectId?: ProjectId | string,
  ) {
    if (!Array.isArray(merges) || merges.length === 0) {
      throw new BadRequestException('merges must contain at least one merge group');
    }
    const results: Array<{
      primaryItem: unknown;
      mergedCount: number;
      softDeletedItemIds: string[];
    }> = [];
    const failedGroups: Array<{ primaryItemId: string; error: string }> = [];
    for (const dto of merges.slice(0, 50)) {
      try {
        const res = await this.mergeDuplicates(userId, dto, projectId);
        results.push({
          primaryItem: res.primaryItem,
          mergedCount: res.mergedCount,
          softDeletedItemIds: res.softDeletedItemIds,
        });
      } catch (err: unknown) {
        failedGroups.push({
          primaryItemId: dto.primaryItemId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const mergedGroupCount = results.length;
    const totalMergedItems = results.reduce((sum, r) => sum + r.mergedCount, 0);
    return {
      success: failedGroups.length === 0,
      mergedGroupCount,
      mergedGroups: mergedGroupCount,
      totalMergedItems,
      mergedItems: totalMergedItems,
      results,
      failedGroups,
    };
  }
}
