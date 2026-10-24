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
import {
  PrismaMergeAuditTrail,
  ALLOWED_MERGE_METADATA_FIELDS,
} from '@/modules/library/ingestion/types/curation.types';
import {
  buildMergeAuditTrail,
  invalidateMergedItemsCache,
} from '@/modules/library/ingestion/domain/duplicate-merge.helper';
import { UserId, ProjectId } from '@/modules/library/core/types/branded.types';
import {
  asMetaObject,
  getEffectiveItemField,
} from './duplicate-detector.service';
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
  syncMergedContributors,
} from '@/modules/library/ingestion/domain/duplicate-merge.domain';

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
  ) {}

  async rewireMergedItemRelations(
    tx: Prisma.TransactionClient,
    primaryId: string,
    uniqueDupIds: string[],
  ): Promise<void> {
    return rewireMergedItemRelations(tx, primaryId, uniqueDupIds);
  }

  async consolidateUserPublications(
    tx: Prisma.TransactionClient,
    primaryId: string,
    uniqueDupIds: string[],
  ): Promise<void> {
    return consolidateUserPublications(tx, primaryId, uniqueDupIds);
  }

  async syncMergedContributors(
    tx: Prisma.TransactionClient,
    primaryId: string,
    chosenContributors: ContributorShape[] | string[] | undefined,
    duplicates: Array<{ contributors?: unknown }>,
  ): Promise<void> {
    return syncMergedContributors(
      tx,
      primaryId,
      chosenContributors,
      duplicates,
    );
  }

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

    const txResult = await this.libraryTx.executeInTransaction(
      async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
        const now = new Date();

        try {
          let hash = 0;
          for (let i = 0; i < primary.id.length; i++) {
            hash = (hash << 5) - hash + primary.id.charCodeAt(i);
            hash |= 0;
          }
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${Math.abs(hash)})`;
        } catch (err) {
          this.logger.warn(
            `Could not acquire pg_advisory_xact_lock: ${(err as Error).message}`,
          );
        }

        const eventScope = { userId, projectId: effectiveProjectId };

        const initialNotes = (await tx.note?.findMany?.({
          where: { itemId: { in: uniqueDupIds } },
          select: { id: true, itemId: true },
        })) || [];
        const initialAttachments = (await tx.attachment?.findMany?.({
          where: { itemId: { in: uniqueDupIds } },
          select: { id: true, itemId: true },
        })) || [];

        if (this.extractionGateway?.reassignContentToItem) {
          await this.extractionGateway.reassignContentToItem(
            uniqueDupIds,
            primary.id,
            tx,
          );
        }

        if (this.catalogGateway) {
          await this.catalogGateway.mergeItems(tx, uniqueDupIds, primary.id);
        }

        const survivingNotes = initialNotes.length > 0 ? ((await tx.note?.findMany?.({
          where: { id: { in: initialNotes.map((n) => n.id) } },
        })) || []) : [];
        const survivingNoteMap = new Map(survivingNotes.map((n) => [n.id, n]));

        for (const initNote of initialNotes) {
          const survivor = survivingNoteMap.get(initNote.id);
          if (survivor && !survivor.deletedAt) {
            await helpers.appendChange(eventScope, {
              entityType: 'Note',
              entityId: survivor.id,
              action: 'update',
              version: 1,
              data: survivor,
            });
          } else {
            await helpers.recordTombstone(eventScope, {
              entityType: 'Note',
              entityId: initNote.id,
            });
            await helpers.appendChange(eventScope, {
              entityType: 'Note',
              entityId: initNote.id,
              action: 'delete',
              version: 0,
            });
          }
        }

        const survivingAttachments = initialAttachments.length > 0 ? ((await tx.attachment?.findMany?.({
          where: { id: { in: initialAttachments.map((a) => a.id) } },
        })) || []) : [];
        const survivingAttachmentMap = new Map(
          survivingAttachments.map((a) => [a.id, a]),
        );

        for (const initAtt of initialAttachments) {
          const survivor = survivingAttachmentMap.get(initAtt.id);
          if (survivor && !survivor.deletedAt) {
            await helpers.appendChange(eventScope, {
              entityType: 'Attachment',
              entityId: survivor.id,
              action: 'update',
              version: 1,
              data: survivor,
            });
          } else {
            await helpers.recordTombstone(eventScope, {
              entityType: 'Attachment',
              entityId: initAtt.id,
            });
            await helpers.appendChange(eventScope, {
              entityType: 'Attachment',
              entityId: initAtt.id,
              action: 'delete',
              version: 0,
            });
          }
        }

        await this.rewireMergedItemRelations(tx, primary.id, uniqueDupIds);
        await this.consolidateUserPublications(tx, primary.id, uniqueDupIds);

        const existingPrimaryMeta = await tx.itemMetadata.findFirst({
          where: { itemId: primary.id },
        });
        const dupMetas = tx.itemMetadata?.findMany
          ? await tx.itemMetadata.findMany({
              where: { itemId: { in: uniqueDupIds } },
              select: { id: true, rawPayload: true },
            })
          : [];
        const extractOffloadedFileId = (rawPayload: unknown): string | null => {
          if (
            rawPayload &&
            typeof rawPayload === 'object' &&
            !Array.isArray(rawPayload)
          ) {
            const rec = rawPayload as Record<string, unknown>;
            if (
              rec.isOffloaded === true &&
              typeof rec.fileId === 'string' &&
              rec.fileId.length > 0
            ) {
              return rec.fileId;
            }
          }
          return null;
        };

        if (existingPrimaryMeta) {
          for (const dm of dupMetas) {
            const fid = extractOffloadedFileId(dm.rawPayload);
            if (fid) offloadedFileIdsToDelete.push(fid);
          }
          await tx.itemMetadata.deleteMany({
            where: { itemId: { in: uniqueDupIds } },
          });
        } else {
          const firstDupMeta =
            dupMetas[0] ??
            (await tx.itemMetadata.findFirst({
              where: { itemId: { in: uniqueDupIds } },
            }));
          if (firstDupMeta) {
            for (const dm of dupMetas) {
              if (dm.id === firstDupMeta.id) continue;
              const fid = extractOffloadedFileId(dm.rawPayload);
              if (fid) offloadedFileIdsToDelete.push(fid);
            }
            await tx.itemMetadata.update({
              where: { id: firstDupMeta.id },
              data: { itemId: primary.id },
            });
            await tx.itemMetadata.deleteMany({
              where: {
                itemId: { in: uniqueDupIds },
                id: { not: firstDupMeta.id },
              },
            });
          }
        }

        // Provenance & Alias Citation Keys
        const primaryMeta = { ...asMetaObject(primary.metadata) };
        const extraIsObject =
          primaryMeta.extra !== null &&
          typeof primaryMeta.extra === 'object' &&
          !Array.isArray(primaryMeta.extra);
        const extraObj: Record<string, unknown> | undefined = extraIsObject
          ? { ...(primaryMeta.extra as Record<string, unknown>) }
          : undefined;

        const existingAliases: string[] = [
          ...(Array.isArray(primaryMeta.mergedCitationKeys)
            ? (primaryMeta.mergedCitationKeys as string[])
            : []),
          ...(extraObj && Array.isArray(extraObj.mergedCitationKeys)
            ? (extraObj.mergedCitationKeys as string[])
            : []),
        ];
        const dupCitationKeys = duplicates
          .flatMap((d) => {
            const dMeta = asMetaObject(d.metadata);
            const dAliases = Array.isArray(dMeta.mergedCitationKeys)
              ? (dMeta.mergedCitationKeys as string[])
              : [];
            return [d.citationKey, ...dAliases];
          })
          .filter((k): k is string =>
            Boolean(k?.trim() && k !== primary.citationKey),
          );
        const mergedAliases = Array.from(
          new Set([...existingAliases, ...dupCitationKeys]),
        );
        primaryMeta.mergedCitationKeys = mergedAliases;
        if (extraObj) extraObj.mergedCitationKeys = mergedAliases;

        const rawSelections = dto.fieldSelections || {};
        const {
          authors: selectedAuthors,
          creators: selectedCreators,
          contributors: selectedContributors,
          ...scalarSelections
        } = rawSelections;

        await this.syncMergedContributors(
          tx,
          primary.id,
          (selectedContributors || selectedAuthors || selectedCreators) as
            | ContributorShape[]
            | string[]
            | undefined,
          duplicates,
        );

        // Automatic Field Backfilling
        const backfillFields: Record<string, unknown> = {};
        for (const field of ALLOWED_MERGE_METADATA_FIELDS) {
          if (field === 'extra' || scalarSelections[field] !== undefined) {
            continue;
          }
          if (
            getEffectiveItemField(primary, field, primaryMeta) === undefined
          ) {
            for (const dup of duplicates) {
              const dupVal = getEffectiveItemField(dup, field);
              if (dupVal !== undefined) {
                backfillFields[field] = dupVal;
                break;
              }
            }
          }
        }

        for (const idKey of IDENTIFIER_META_KEYS) {
          if (
            primaryMeta[idKey] === undefined ||
            primaryMeta[idKey] === null ||
            primaryMeta[idKey] === ''
          ) {
            const topOnPrimary = getEffectiveItemField(
              primary,
              idKey,
              primaryMeta,
            );
            if (topOnPrimary !== undefined) {
              primaryMeta[idKey] = topOnPrimary;
            } else {
              for (const dup of duplicates) {
                const candidateVal = getEffectiveItemField(dup, idKey);
                if (candidateVal !== undefined) {
                  primaryMeta[idKey] = candidateVal;
                  backfillFields[idKey] = candidateVal;
                  break;
                }
              }
            }
          }
        }

        // Non-destructively merge Zotero string `extra` lines
        if (scalarSelections.extra === undefined) {
          const extraLines: string[] = [];
          const seenLinesLower = new Set<string>();
          const pushExtraLines = (rawExtra: unknown) => {
            if (typeof rawExtra !== 'string' || !rawExtra.trim()) return;
            for (const line of rawExtra.split(/\r?\n/)) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              const lower = trimmed.toLowerCase();
              if (!seenLinesLower.has(lower)) {
                seenLinesLower.add(lower);
                extraLines.push(trimmed);
              }
            }
          };

          pushExtraLines(primaryMeta.extra);
          pushExtraLines((primary as unknown as Record<string, unknown>).extra);
          for (const dup of duplicates) {
            pushExtraLines(asMetaObject(dup.metadata).extra);
            pushExtraLines((dup as unknown as Record<string, unknown>).extra);
          }

          if (extraLines.length > 0 && !extraObj) {
            primaryMeta.extra = extraLines.join('\n');
          } else if (extraObj) {
            primaryMeta.extra = extraObj;
          }
        }

        // Preserve My Publications & Retraction warnings across merge
        let mergedIsRetracted = Boolean(
          (primary as { isRetracted?: boolean }).isRetracted ||
            primaryMeta.isRetracted,
        );
        for (const dup of duplicates) {
          const dupMeta = asMetaObject(dup.metadata);
          if (dupMeta.isMyPublication === true) {
            primaryMeta.isMyPublication = true;
            for (const pubKey of [
              'publicationConfirmedAt',
              'openAccessLicense',
              'isPublicPublication',
            ] as const) {
              if (
                primaryMeta[pubKey] === undefined &&
                dupMeta[pubKey] !== undefined
              ) {
                primaryMeta[pubKey] = dupMeta[pubKey];
              }
            }
          }

          if (
            (dup as { isRetracted?: boolean }).isRetracted ||
            dupMeta.isRetracted ||
            dupMeta.retraction
          ) {
            mergedIsRetracted = true;
            primaryMeta.isRetracted = true;
            for (const rKey of RETRACTION_SURVIVAL_KEYS) {
              if (!primaryMeta[rKey] && dupMeta[rKey] !== undefined) {
                primaryMeta[rKey] = dupMeta[rKey];
              }
            }
          }
        }

        const currentHistory = Array.isArray(primaryMeta.mergeHistory)
          ? (primaryMeta.mergeHistory as unknown[])
          : [];
        primaryMeta.mergeHistory = [
          ...currentHistory,
          {
            mergedAt: now.toISOString(),
            duplicateItemIds: uniqueDupIds,
            backfilledFields: Object.keys(backfillFields),
          },
        ];

        const primaryContributors = (await tx.contributor?.findMany?.({
          where: { itemId: primary.id },
          orderBy: { orderIndex: 'asc' },
        })) || (primary as { contributors?: Array<Record<string, unknown>> }).contributors || [];
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

        const combinedUpdates = { ...backfillFields, ...scalarSelections };
        const topLevelData: Record<string, unknown> = {
          itemType: effectiveMergedItemType,
          ...(derivedFirstAuthor ? { firstAuthor: derivedFirstAuthor } : {}),
          ...(noteCount !== undefined ? { noteCount } : {}),
          ...(attachmentCount !== undefined ? { attachmentCount, hasFile: attachmentCount > 0 } : {}),
          ...(mergedIsRetracted ? { isRetracted: true } : {}),
        };
        for (const [key, val] of Object.entries(combinedUpdates)) {
          if (TOP_LEVEL_ITEM_COLUMNS.has(key)) {
            topLevelData[key] = val;
          } else {
            primaryMeta[key] = val;
          }
        }

        const updatedPrimary = await tx.item.update({
          where: { id: primary.id },
          data: {
            ...topLevelData,
            metadata: primaryMeta as Prisma.InputJsonValue,
            version: { increment: 1 },
          },
        });

        await helpers.appendChange(eventScope, {
          entityType: 'Item',
          entityId: updatedPrimary.id,
          action: 'update',
          version: updatedPrimary.version,
          data: updatedPrimary,
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

        for (const dup of duplicates) {
          const dupMeta = {
            ...asMetaObject(dup.metadata),
            mergedIntoId: primary.id,
            mergedAt: now.toISOString(),
          };
          const softDeleted = await tx.item.update({
            where: { id: dup.id },
            data: {
              deletedAt: now,
              metadata: dupMeta,
              version: { increment: 1 },
            },
          });

          await helpers.recordTombstone(eventScope, {
            entityType: 'Item',
            entityId: dup.id,
          });
          await helpers.appendChange(eventScope, {
            entityType: 'Item',
            entityId: dup.id,
            action: 'delete',
            version: softDeleted.version,
            data: softDeleted,
          });
          await helpers.publishOutbox(
            eventScope,
            dup.id,
            'library.item.merged_into',
            {
              duplicateId: dup.id,
              primaryId: primary.id,
              userId,
              projectId: effectiveProjectId,
            },
          );
        }

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
        const audit: PrismaMergeAuditTrail = buildMergeAuditTrail({
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

    if (
      offloadedFileIdsToDelete.length > 0 &&
      this.storagePort?.deleteFile
    ) {
      for (const fid of offloadedFileIdsToDelete) {
        try {
          await this.storagePort.deleteFile(fid);
        } catch (delErr: unknown) {
          const msg =
            delErr instanceof Error ? delErr.message : String(delErr);
          this.logger.warn(
            `Failed to delete offloaded duplicate ItemMetadata blob ${fid}: ${msg}`,
          );
        }
      }
    }

    await invalidateMergedItemsCache({
      cache: this.cache,
      logger: this.logger,
      primaryId: primary.id,
      uniqueDupIds,
      userId: String(userId),
      effectiveProjectId,
    });

    return txResult;
  }
}
