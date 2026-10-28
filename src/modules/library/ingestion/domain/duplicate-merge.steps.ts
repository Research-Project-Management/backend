import { Prisma } from '@prisma/client';
import {
  ALLOWED_MERGE_METADATA_FIELDS,
  PrismaMergeAuditTrail,
} from '@/modules/library/ingestion/types/curation.types';
import {
  asMetaObject,
  getEffectiveItemField,
} from '@/modules/library/ingestion/services/duplicate-detector.service';
import {
  ContributorShape,
  IDENTIFIER_META_KEYS,
  RETRACTION_SURVIVAL_KEYS,
  SYSTEM_RESERVED_MERGE_KEYS,
  syncMergedContributors,
} from './duplicate-merge.domain';
import { buildMergeAuditTrail } from './duplicate-merge.helper';
import { deriveFirstAuthor } from '@/modules/library/catalog';
import {
  ItemProvenancePolicy,
  FieldProvenanceRecord,
  isPlaceholderItemTitle,
} from '@/modules/library/core';

export interface DuplicateMergeStepContext {
  tx: Prisma.TransactionClient;
  primary: Record<string, unknown> & {
    id: string;
    citationKey?: string | null;
    metadata?: unknown;
  };
  duplicates: Array<
    Record<string, unknown> & {
      id: string;
      citationKey?: string | null;
      doi?: string | null;
      metadata?: unknown;
      contributors?: unknown;
    }
  >;
  uniqueDupIds: string[];
  rawSelections: Record<string, unknown>;
  scalarSelections: Record<string, unknown>;
  primaryMeta: Record<string, unknown>;
  backfillFields: Record<string, unknown>;
  offloadedFileIdsToDelete: string[];
  capturedPrimaryItemMetadata?: Array<Record<string, unknown>>;
  capturedDuplicateItemMetadata?: Array<Record<string, unknown>>;
  reassignedItemMetadata?: Array<{ id: string; previousItemId: string }>;
  syncedContributors?: Array<Record<string, unknown>>;
  now: Date;
}

export interface IDuplicateMergeStep {
  readonly stepName: string;
  execute(context: DuplicateMergeStepContext): Promise<void> | void;
}

export class ItemMetadataConsolidationMergeStep
  implements IDuplicateMergeStep
{
  readonly stepName = 'ITEM_METADATA_CONSOLIDATION';

  async execute(ctx: DuplicateMergeStepContext): Promise<void> {
    const { tx, primary, uniqueDupIds } = ctx;
    const [primaryMetaRows, dupMetas] = await Promise.all([
      tx.itemMetadata?.findMany
        ? tx.itemMetadata.findMany({
            where: { itemId: primary.id },
          })
        : (async () => {
            const first = await tx.itemMetadata?.findFirst?.({
              where: { itemId: primary.id },
            });
            return first ? [first] : [];
          })(),
      tx.itemMetadata?.findMany
        ? tx.itemMetadata.findMany({
            where: { itemId: { in: uniqueDupIds } },
            select: {
              id: true,
              itemId: true,
              sourceProvider: true,
              rawPayload: true,
            },
          })
        : Promise.resolve([]),
    ]);

    const resolvedPrimaryMetas = Array.isArray(primaryMetaRows)
      ? primaryMetaRows
      : [];
    ctx.capturedPrimaryItemMetadata = resolvedPrimaryMetas.map((m) => ({
      ...(m as unknown as Record<string, unknown>),
    }));

    const resolvedDupMetas =
      dupMetas.length > 0
        ? dupMetas
        : tx.itemMetadata?.findFirst
          ? await (async () => {
              const firstDup = await tx.itemMetadata.findFirst({
                where: { itemId: { in: uniqueDupIds } },
              });
              return firstDup ? [firstDup] : [];
            })()
          : [];

    if (resolvedDupMetas.length > 0) {
      ctx.capturedDuplicateItemMetadata = resolvedDupMetas.map((m) => ({
        ...(m as unknown as Record<string, unknown>),
      }));
    }

    const coveredProviders = new Set<string>(
      resolvedPrimaryMetas
        .map((m) =>
          typeof (m as { sourceProvider?: unknown }).sourceProvider === 'string'
            ? (m as { sourceProvider: string }).sourceProvider.trim().toLowerCase()
            : '',
        )
        .filter(Boolean),
    );

    const reassignedList: Array<{ id: string; previousItemId: string }> = [];
    for (const dm of resolvedDupMetas) {
      const dmRec = dm as {
        id?: string;
        itemId?: string;
        sourceProvider?: string;
      };
      if (!dmRec.id) continue;
      const providerKey =
        typeof dmRec.sourceProvider === 'string' && dmRec.sourceProvider.trim()
          ? dmRec.sourceProvider.trim().toLowerCase()
          : '';
      const shouldReassign =
        providerKey.length > 0
          ? !coveredProviders.has(providerKey)
          : resolvedPrimaryMetas.length === 0 && reassignedList.length === 0;

      if (shouldReassign) {
        if (providerKey) coveredProviders.add(providerKey);
        reassignedList.push({
          id: dmRec.id,
          previousItemId: dmRec.itemId || uniqueDupIds[0],
        });
        if (typeof tx.itemMetadata?.update === 'function') {
          await tx.itemMetadata.update({
            where: { id: dmRec.id },
            data: { itemId: primary.id },
          });
        }
      }
    }

    ctx.reassignedItemMetadata = reassignedList;
  }
}

export class MetadataAndCreatorBackfillMergeStep
  implements IDuplicateMergeStep
{
  readonly stepName = 'METADATA_AND_CREATOR_BACKFILL';

  async execute(ctx: DuplicateMergeStepContext): Promise<void> {
    const {
      tx,
      primary,
      duplicates,
      rawSelections,
      scalarSelections,
      primaryMeta,
      backfillFields,
    } = ctx;

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

    const chosenContributors = (rawSelections.contributors ??
      rawSelections.authors ??
      rawSelections.creators) as ContributorShape[] | string[] | undefined;

    const syncedContributors = await syncMergedContributors(
      tx,
      primary.id,
      chosenContributors,
      duplicates,
      primary,
      primaryMeta,
    );
    if (Array.isArray(chosenContributors) && chosenContributors.length === 0) {
      ctx.syncedContributors = [];
      backfillFields.firstAuthor = null;
    } else if (syncedContributors.length > 0) {
      ctx.syncedContributors = syncedContributors;
      const derivedAuthor = deriveFirstAuthor({
        contributors: syncedContributors,
        itemType: String(
          scalarSelections.itemType || primary.itemType || primary.type || '',
        ),
      });
      if (derivedAuthor) {
        backfillFields.firstAuthor = derivedAuthor;
      }
    }

    const { lockedSet: primaryLockedSet, provenanceMap: primaryProvenance } =
      ItemProvenancePolicy.extractProvenanceState(primaryMeta);

    const createManualProvenance = (): FieldProvenanceRecord => ({
      ...ItemProvenancePolicy.createUserOverrideRecord(),
      lockedByUser: true,
      isFilenameTitle: false,
    });

    for (const [selKey, selVal] of Object.entries(scalarSelections)) {
      if (
        selVal === undefined ||
        selKey === 'extraFields' ||
        selKey === 'metadata' ||
        SYSTEM_RESERVED_MERGE_KEYS.has(selKey)
      ) {
        continue;
      }
      if (selVal === '' || selVal === null) {
        primaryLockedSet.delete(selKey);
        delete primaryProvenance[selKey];
        for (const alias of ItemProvenancePolicy.getCoupledFieldAliases(selKey)) {
          primaryLockedSet.delete(alias);
          delete primaryProvenance[alias];
        }
        continue;
      }
      const manualProv = createManualProvenance();
      primaryProvenance[selKey] = manualProv;
      primaryLockedSet.add(selKey);
      for (const alias of ItemProvenancePolicy.getCoupledFieldAliases(selKey)) {
        primaryProvenance[alias] = { ...manualProv };
        primaryLockedSet.add(alias);
      }
    }

    const isDupFieldUserLocked = (
      dupMeta: Record<string, unknown>,
      fieldKey: string,
    ) => ItemProvenancePolicy.inspectFieldUserLock(dupMeta, fieldKey);

    for (const field of ALLOWED_MERGE_METADATA_FIELDS) {
      if (field === 'extra' || scalarSelections[field] !== undefined) {
        continue;
      }

      const sortedDupsForField = [...duplicates].sort(
        (a, b) =>
          ItemProvenancePolicy.getFieldAuthority(b, field, true) -
          ItemProvenancePolicy.getFieldAuthority(a, field, true),
      );

      // 1. If a duplicate has a user-locked override on this field and primary does NOT have it locked, promote the duplicate's user-curated value
      if (!primaryLockedSet.has(field)) {
        let promotedFromLockedDup = false;
        for (const dup of sortedDupsForField) {
          const dupMeta = asMetaObject(dup.metadata);
          const lockCheck = isDupFieldUserLocked(dupMeta, field);
          if (lockCheck.locked) {
            const dupVal = getEffectiveItemField(dup, field, dupMeta, {
              excludeGenericsFromSpecificTarget: true,
            });
            if (dupVal !== undefined) {
              backfillFields[field] = dupVal;
              primaryLockedSet.add(field);
              if (lockCheck.provenance) {
                primaryProvenance[field] = lockCheck.provenance;
              }
              promotedFromLockedDup = true;
              break;
            }
          }
        }
        if (promotedFromLockedDup) continue;
      }

      const isPreprintVenueString = (v: unknown): boolean =>
        typeof v === 'string' &&
        /^(?:arxiv(?:\.org)?|corr|biorxiv|medrxiv|chemrxiv|techrxiv|ssrn|research\s+square|osf\s+preprints|hal|zenodo)(?:\s+preprints?|\s+e-?prints?)?$/i.test(
          v.trim(),
        );

      const existingPrimaryVal = getEffectiveItemField(
        primary,
        field,
        primaryMeta,
        { excludeGenericsFromSpecificTarget: true },
      );
      const isPrimaryPlaceholderTitle =
        field === 'title' &&
        !primaryLockedSet.has('title') &&
        (isPlaceholderItemTitle(String(primary.title || '')) ||
          primaryMeta.isFilenameTitle === true ||
          primaryProvenance.title?.isFilenameTitle === true);
      const isPrimaryPreprintVenue =
        (field === 'publicationTitle' || field === 'journal') &&
        !primaryLockedSet.has('publicationTitle') &&
        !primaryLockedSet.has('journal') &&
        isPreprintVenueString(existingPrimaryVal);

      // 2. Standard backfill when primary is empty OR upgrade when primary has placeholder title / preprint venue
      if (
        existingPrimaryVal === undefined ||
        isPrimaryPlaceholderTitle ||
        isPrimaryPreprintVenue
      ) {
        const primaryFieldAuth = isPrimaryPreprintVenue
          ? ItemProvenancePolicy.getFieldAuthority(primary, field, true)
          : 0;
        for (const dup of sortedDupsForField) {
          const dupMeta = asMetaObject(dup.metadata);
          const dupVal = getEffectiveItemField(dup, field, dupMeta, {
            excludeGenericsFromSpecificTarget: true,
          });
          if (dupVal !== undefined) {
            if (
              field === 'title' &&
              (isPlaceholderItemTitle(String(dupVal)) ||
                dupMeta.isFilenameTitle === true)
            ) {
              continue;
            }
            if (isPrimaryPreprintVenue) {
              if (isPreprintVenueString(dupVal)) continue;
              const dupFieldAuth = ItemProvenancePolicy.getFieldAuthority(
                dup,
                field,
                true,
              );
              if (dupFieldAuth < primaryFieldAuth) continue;
            }
            backfillFields[field] = dupVal;
            const dupProvMap =
              dupMeta.fieldProvenance &&
              typeof dupMeta.fieldProvenance === 'object' &&
              !Array.isArray(dupMeta.fieldProvenance)
                ? (dupMeta.fieldProvenance as Record<string, unknown>)
                : {};
            if (dupProvMap[field] && typeof dupProvMap[field] === 'object') {
              if (
                primaryProvenance[field] === undefined ||
                isPrimaryPlaceholderTitle ||
                isPrimaryPreprintVenue
              ) {
                primaryProvenance[field] = {
                  ...(dupProvMap[field] as FieldProvenanceRecord),
                };
              }
            }
            break;
          }
        }
      }
    }

    if (
      scalarSelections.title !== undefined ||
      backfillFields.title !== undefined
    ) {
      primaryMeta.isFilenameTitle = false;
      if (
        primaryProvenance.title &&
        typeof primaryProvenance.title === 'object'
      ) {
        primaryProvenance.title = {
          ...primaryProvenance.title,
          isFilenameTitle: false,
        };
      }
    }

    for (const idKey of IDENTIFIER_META_KEYS) {
      if (scalarSelections[idKey] !== undefined) {
        if (scalarSelections[idKey] === '' || scalarSelections[idKey] === null) {
          delete primaryMeta[idKey];
          for (const alias of ItemProvenancePolicy.getCoupledFieldAliases(idKey)) {
            delete primaryMeta[alias];
          }
        } else {
          primaryMeta[idKey] = scalarSelections[idKey];
        }
        continue;
      }
      if (
        primaryMeta[idKey] === undefined ||
        primaryMeta[idKey] === null ||
        primaryMeta[idKey] === ''
      ) {
        const topOnPrimary = getEffectiveItemField(primary, idKey, primaryMeta);
        if (topOnPrimary !== undefined) {
          primaryMeta[idKey] = topOnPrimary;
        } else {
          const sortedDupsForId = [...duplicates].sort(
            (a, b) =>
              ItemProvenancePolicy.getFieldAuthority(b, idKey, true) -
              ItemProvenancePolicy.getFieldAuthority(a, idKey, true),
          );
          for (const dup of sortedDupsForId) {
            const dupMeta = asMetaObject(dup.metadata);
            const candidateVal = getEffectiveItemField(dup, idKey, dupMeta);
            if (candidateVal !== undefined) {
              primaryMeta[idKey] = candidateVal;
              backfillFields[idKey] = candidateVal;
              const lockCheck = isDupFieldUserLocked(dupMeta, idKey);
              if (lockCheck.locked) {
                primaryLockedSet.add(idKey);
              }
              if (
                lockCheck.provenance &&
                primaryProvenance[idKey] === undefined
              ) {
                primaryProvenance[idKey] = lockCheck.provenance;
              }
              break;
            }
          }
        }
      }
    }

    if (primaryLockedSet.size > 0 || Array.isArray(primaryMeta.lockedFields)) {
      primaryMeta.lockedFields = Array.from(primaryLockedSet);
    }
    if (Object.keys(primaryProvenance).length > 0 || primaryMeta.fieldProvenance !== undefined) {
      primaryMeta.fieldProvenance = primaryProvenance;
    }

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
      pushExtraLines(primary.extra);
      for (const dup of duplicates) {
        pushExtraLines(asMetaObject(dup.metadata).extra);
        pushExtraLines(dup.extra);
      }

      if (extraLines.length > 0 && !extraObj) {
        primaryMeta.extra = extraLines.join('\n');
      } else if (extraObj) {
        primaryMeta.extra = extraObj;
      }
    }
  }
}

export class RetractionSurvivalMergeStep implements IDuplicateMergeStep {
  readonly stepName = 'RETRACTION_AND_PUBLICATION_SURVIVAL';

  execute(ctx: DuplicateMergeStepContext): void {
    const { duplicates, uniqueDupIds, primaryMeta, backfillFields, now } = ctx;

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
        dupMeta.retraction ||
        dupMeta.retractionNature ||
        dupMeta.retractionDetails
      ) {
        primaryMeta.isRetracted = true;
        for (const rKey of RETRACTION_SURVIVAL_KEYS) {
          if (!primaryMeta[rKey] && dupMeta[rKey] !== undefined) {
            primaryMeta[rKey] = dupMeta[rKey];
          }
        }
      } else if (
        !primaryMeta.retractionCheckedAt &&
        dupMeta.retractionCheckedAt
      ) {
        primaryMeta.retractionCheckedAt = dupMeta.retractionCheckedAt;
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
  }
}

export class AuditSnapshotBuilder {
  static build(params: {
    primary: {
      id: string;
      doi?: string | null;
      citationKey?: string | null;
    };
    duplicates: Array<{ doi?: string | null }>;
    uniqueDupIds: string[];
    finalPrimary: unknown;
    primaryMeta: Record<string, unknown>;
    backfillFields: Record<string, unknown>;
    now: Date;
  }): PrismaMergeAuditTrail {
    return buildMergeAuditTrail(params);
  }
}

export const DEFAULT_DUPLICATE_MERGE_STEPS: readonly IDuplicateMergeStep[] = [
  new ItemMetadataConsolidationMergeStep(),
  new MetadataAndCreatorBackfillMergeStep(),
  new RetractionSurvivalMergeStep(),
];

export async function executeDuplicateMergePipeline(
  context: DuplicateMergeStepContext,
  steps: readonly IDuplicateMergeStep[] = DEFAULT_DUPLICATE_MERGE_STEPS,
): Promise<void> {
  for (const step of steps) {
    await step.execute(context);
  }
}
