import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  Inject,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  TransactionService,
  TransactionHelpers,
  LIBRARY_EVENT_TYPES,
  CATALOG_FACADE,
  ICatalogFacade,
  EXTRACTION_FACADE,
  IExtractionFacade,
  normalizeDoi,
} from '@/modules/library/core';
import { IngestionRepository } from '@/modules/library/ingestion/repositories/ingestion.repository';
import { MergeDuplicatesDto } from '@/modules/library/ingestion/dto/curation.dto';
import {
  PrismaMergeAuditTrail,
  ALLOWED_MERGE_METADATA_FIELDS,
} from '@/modules/library/ingestion/types/curation.types';
import { UserId, ProjectId } from '@/modules/library/core/types/branded.types';
import {
  asMetaObject,
  getEffectiveItemField,
} from './duplicate-detector.service';

export interface ContributorShape {
  creatorType?: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  name?: string;
  orderIndex?: number;
}

export const SYSTEM_RESERVED_MERGE_KEYS = new Set([
  'id',
  'userId',
  'projectId',
  'deletedAt',
  'createdAt',
  'updatedAt',
  'version',
]);

export const TOP_LEVEL_ITEM_COLUMNS = new Set([
  'title',
  'itemType',
  'year',
  'citationKey',
  'doi',
  'publicationTitle',
  'abstract',
  'url',
  'isRetracted',
]);

export const IDENTIFIER_META_KEYS = [
  'arxivId',
  'pmid',
  'pmcid',
  'isbn',
  'issn',
] as const;

export const RETRACTION_SURVIVAL_KEYS = [
  'retraction',
  'retractionDate',
  'retractionNature',
  'retractionReasons',
  'retractionNoticeDoi',
  'retractionSource',
] as const;

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
  ) {}

  private normalizeScopeProjectId(
    rawProjectId?: ProjectId | string | null,
  ): string | undefined {
    if (!rawProjectId || typeof rawProjectId !== 'string') return undefined;
    const trimmed = rawProjectId.trim();
    if (
      !trimmed ||
      ['user', 'me', 'personal'].includes(trimmed.toLowerCase())
    ) {
      return undefined;
    }
    return trimmed;
  }

  async rewireMergedItemRelations(
    tx: Prisma.TransactionClient,
    primaryId: string,
    uniqueDupIds: string[],
  ): Promise<void> {
    const existingRelations = await tx.itemRelation.findMany({
      where: {
        OR: [
          { sourceItemId: { in: [primaryId, ...uniqueDupIds] } },
          { targetItemId: { in: [primaryId, ...uniqueDupIds] } },
        ],
      },
    });

    const primaryExistingPairs = new Set<string>();
    for (const rel of existingRelations) {
      if (rel.sourceItemId === primaryId || rel.targetItemId === primaryId) {
        primaryExistingPairs.add(
          `${rel.sourceItemId}::${rel.targetItemId}::${rel.relationType}`,
        );
      }
    }

    for (const rel of existingRelations) {
      const isSourceDup = uniqueDupIds.includes(rel.sourceItemId);
      const isTargetDup = uniqueDupIds.includes(rel.targetItemId);
      if (!isSourceDup && !isTargetDup) continue;

      const newSourceId = isSourceDup ? primaryId : rel.sourceItemId;
      const newTargetId = isTargetDup ? primaryId : rel.targetItemId;

      if (newSourceId === newTargetId) {
        await tx.itemRelation.delete({ where: { id: rel.id } });
        continue;
      }

      const candidateKey = `${newSourceId}::${newTargetId}::${rel.relationType}`;
      if (primaryExistingPairs.has(candidateKey)) {
        await tx.itemRelation.delete({ where: { id: rel.id } });
      } else {
        await tx.itemRelation.update({
          where: { id: rel.id },
          data: { sourceItemId: newSourceId, targetItemId: newTargetId },
        });
        primaryExistingPairs.add(candidateKey);
      }
    }
  }

  async consolidateUserPublications(
    tx: Prisma.TransactionClient,
    primaryId: string,
    uniqueDupIds: string[],
  ): Promise<void> {
    if (typeof tx.userPublication?.findMany !== 'function') return;
    const dupPublications = await tx.userPublication.findMany({
      where: { itemId: { in: uniqueDupIds } },
    });

    for (const pub of dupPublications) {
      const existingPrimaryPub = await tx.userPublication.findUnique({
        where: {
          userId_itemId: { userId: pub.userId, itemId: primaryId },
        },
      });

      if (!existingPrimaryPub) {
        await tx.userPublication.create({
          data: {
            userId: pub.userId,
            itemId: primaryId,
            contributorId: pub.contributorId,
            isPublic: pub.isPublic,
            openAccessLicense: pub.openAccessLicense,
            addedAt: pub.addedAt,
          },
        });
      } else {
        await tx.userPublication.update({
          where: {
            userId_itemId: { userId: pub.userId, itemId: primaryId },
          },
          data: {
            isPublic: existingPrimaryPub.isPublic || pub.isPublic,
            openAccessLicense:
              existingPrimaryPub.openAccessLicense || pub.openAccessLicense,
            contributorId:
              existingPrimaryPub.contributorId || pub.contributorId,
          },
        });
      }

      await tx.userPublication.delete({
        where: {
          userId_itemId: { userId: pub.userId, itemId: pub.itemId },
        },
      });
    }
  }

  async syncMergedContributors(
    tx: Prisma.TransactionClient,
    primaryId: string,
    chosenContributors: ContributorShape[] | string[] | undefined,
    duplicates: Array<{ contributors?: unknown }>,
  ): Promise<void> {
    const mapContributorInput = (c: ContributorShape | string, idx: number) => {
      const cObj = typeof c === 'object' && c !== null ? c : null;
      const firstName = cObj?.firstName || '';
      const lastName = cObj?.lastName || '';
      const fullName =
        cObj?.fullName ||
        cObj?.name ||
        [firstName, lastName].filter(Boolean).join(' ') ||
        (typeof c === 'string' ? c : '');
      return {
        itemId: primaryId,
        creatorType: cObj?.creatorType || 'author',
        firstName,
        lastName,
        fullName,
        orderIndex: cObj?.orderIndex ?? idx,
      };
    };

    if (Array.isArray(chosenContributors) && chosenContributors.length > 0) {
      if (typeof tx.contributor?.deleteMany === 'function') {
        await tx.contributor.deleteMany({ where: { itemId: primaryId } });
        await tx.contributor.createMany({
          data: chosenContributors.map(mapContributorInput),
        });
      }
      return;
    }

    if (typeof tx.contributor?.count === 'function') {
      const primaryContribCount = await tx.contributor.count({
        where: { itemId: primaryId },
      });
      if (primaryContribCount === 0) {
        const donor = duplicates.find(
          (d) => Array.isArray(d.contributors) && d.contributors.length > 0,
        );
        if (donor && Array.isArray(donor.contributors)) {
          await tx.contributor.createMany({
            data: (donor.contributors as ContributorShape[]).map(
              mapContributorInput,
            ),
          });
        }
      }
    }
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

    const effectiveProjectId = this.normalizeScopeProjectId(
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
        const itemProjectId = this.normalizeScopeProjectId(
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

    return this.libraryTx.executeInTransaction(
      async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
        const now = new Date();

        if (typeof tx.$executeRaw === 'function') {
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
        }

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

        await this.rewireMergedItemRelations(tx, primary.id, uniqueDupIds);
        await this.consolidateUserPublications(tx, primary.id, uniqueDupIds);

        if (typeof tx.itemMetadata?.updateMany === 'function') {
          await tx.itemMetadata.updateMany({
            where: { itemId: { in: uniqueDupIds } },
            data: { itemId: primary.id },
          });
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
            ContributorShape[] | string[] | undefined,
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

        const combinedUpdates = { ...backfillFields, ...scalarSelections };
        const topLevelData: Record<string, unknown> = {
          itemType: effectiveMergedItemType,
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

        const eventScope = { userId, projectId: effectiveProjectId };
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
        const normPrimaryDoi = normalizeDoi(primary.doi);
        const matchReasons = Array.from(
          new Set(
            duplicates.map((dup) => {
              const normDupDoi = normalizeDoi(dup.doi);
              return normPrimaryDoi &&
                normDupDoi &&
                normPrimaryDoi === normDupDoi
                ? 'EXACT_DOI'
                : 'FUZZY_TITLE_YEAR_AUTHOR';
            }),
          ),
        );

        const preservedCitationKeys = Array.from(
          new Set(
            [
              (finalPrimary as { citationKey?: string | null }).citationKey ??
                primary.citationKey,
              ...(Array.isArray(primaryMeta.mergedCitationKeys)
                ? (primaryMeta.mergedCitationKeys as string[])
                : []),
            ].filter((k): k is string => typeof k === 'string' && k.length > 0),
          ),
        );

        const reloadedWithRelations = finalPrimary as {
          attachments?: unknown[];
          notesList?: unknown[];
          itemTags?: unknown[];
          collectionItems?: unknown[];
        };

        const audit: PrismaMergeAuditTrail = {
          masterItemId: primary.id,
          mergedDuplicateIds: uniqueDupIds,
          matchReasons,
          preservedCitationKeys,
          consolidatedAttachments: Array.isArray(
            reloadedWithRelations.attachments,
          )
            ? reloadedWithRelations.attachments.length
            : 0,
          consolidatedNotes: Array.isArray(reloadedWithRelations.notesList)
            ? reloadedWithRelations.notesList.length
            : 0,
          consolidatedTags: Array.isArray(reloadedWithRelations.itemTags)
            ? reloadedWithRelations.itemTags.length
            : 0,
          consolidatedCollections: Array.isArray(
            reloadedWithRelations.collectionItems,
          )
            ? reloadedWithRelations.collectionItems.length
            : 0,
          backfilledFields: Object.keys(backfillFields),
          timestamp: now.toISOString(),
        };

        return {
          primaryItem: finalPrimary,
          mergedCount: duplicates.length,
          softDeletedItemIds: uniqueDupIds,
          audit,
          prismaAudit: audit,
        };
      },
    );
  }
}
