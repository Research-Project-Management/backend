import { Prisma } from '@prisma/client';
import {
  cleanAbstractText,
  getEffectiveBaseFieldMap,
  getEffectiveReverseBaseFieldMap,
  getPrimaryCreatorRoleForType,
  getValidCreatorMapForType,
  sanitizeItemTitle,
} from '@/modules/library/core';
import { parseAccessDate } from '@/modules/library/catalog/types/items.constants';
import {
  CreateItemData,
  UpdateItemData,
  ItemDetail,
} from '@/modules/library/core/types/bibliographic.types';
import { TagInput } from '@/modules/library/catalog/types/tags.types';
import {
  extractExtraKeyValues,
  normalizeItemIdentifiers,
  resolveExtraPlainText,
  prepareNotesToCreate,
  prepareAttachmentsToCreate,
  deriveFirstAuthor,
  prepareContributorsToCreate,
  applyManualEditProvenanceLocks,
} from './creator-tag-payload.builder';
import {
  buildCollectionItemsUpdatePatch,
  syncMetadataIdentifierAliases,
  applyMetadataProvenanceAndTelemetry,
} from './identifier-change.helper';
import {
  CanonicalCommandFields,
  COUPLED_TYPE_SPECIFIC_TO_BASE,
  DIRECT_STRING_METADATA_KEYS,
  resolveCanonicalCommandFields,
} from './command-payload.builder';

export function buildMetadataPartial(params: {
  mode: 'create' | 'update';
  baseMeta: Record<string, unknown>;
  data: CreateItemData | UpdateItemData;
  canonical: CanonicalCommandFields;
  ids: ReturnType<typeof normalizeItemIdentifiers>;
  rawTags?: (TagInput | null | undefined)[];
  existingRawExtra?: string | null;
  uploadedById?: string;
}): Record<string, unknown> {
  const {
    mode,
    baseMeta,
    data,
    canonical,
    ids,
    existingRawExtra,
    uploadedById,
  } = params;
  const isCreate = mode === 'create';
  const dataRecord = data as Record<string, unknown>;
  const dataExtra =
    data.extraFields && typeof data.extraFields === 'object'
      ? data.extraFields
      : {};
  const getRawField = (key: string): unknown =>
    dataRecord[key] !== undefined ? dataRecord[key] : dataExtra[key];

  const formatTrimmedOrNull = (val: string | number | null | undefined) =>
    val === undefined
      ? isCreate
        ? ''
        : undefined
      : val === null
        ? isCreate
          ? ''
          : null
        : String(val).trim();

  const formatPositiveCount = (val: unknown) =>
    val === undefined
      ? isCreate
        ? null
        : undefined
      : val !== null &&
          val !== '' &&
          typeof val !== 'boolean' &&
          Number.isFinite(Number(val)) &&
          Number(val) >= 0
        ? Number(val)
        : null;

  const result: Record<string, unknown> = { ...baseMeta };
  if (data.metadata && typeof data.metadata === 'object') {
    Object.assign(result, data.metadata);
  }
  const setIfDefined = (key: string, val: unknown) => {
    if (val !== undefined) result[key] = val;
  };

  if (canonical.itemType !== 'preprint') {
    setIfDefined(
      'publicationTitle',
      isCreate ? (canonical.rawPubTitle ?? '').trim() : canonical.rawPubTitle,
    );
  } else {
    const repoCandidate =
      getRawField('repository') ??
      canonical.rawPublisher ??
      canonical.rawPubTitle;
    if (typeof repoCandidate === 'string' && repoCandidate.trim()) {
      result.repository = repoCandidate.trim();
      result.publicationTitle = repoCandidate.trim();
    } else if (canonical.rawPubTitle !== undefined) {
      setIfDefined(
        'publicationTitle',
        isCreate ? (canonical.rawPubTitle ?? '').trim() : canonical.rawPubTitle,
      );
    }
  }
  const createDateStr =
    (canonical.rawPubDate ?? '').trim() || (data.year ? String(data.year) : '');
  if (isCreate) {
    result.publicationDate = createDateStr;
    result.date = createDateStr;
  } else if (canonical.rawPubDate !== undefined) {
    result.publicationDate = canonical.rawPubDate;
    result.date = canonical.rawPubDate;
  }

  setIfDefined(
    'publisher',
    isCreate ? (canonical.rawPublisher ?? '').trim() : canonical.rawPublisher,
  );
  setIfDefined(
    'place',
    isCreate ? (canonical.rawPlace ?? '').trim() : canonical.rawPlace,
  );
  setIfDefined('volume', formatTrimmedOrNull(canonical.rawVolume));
  setIfDefined('issue', formatTrimmedOrNull(canonical.rawIssue));
  setIfDefined('pages', formatTrimmedOrNull(canonical.rawPages));
  setIfDefined('edition', formatTrimmedOrNull(canonical.rawEdition));
  if (canonical.rawTypeField !== undefined) {
    result.type = canonical.rawTypeField;
  }

  for (const key of DIRECT_STRING_METADATA_KEYS) {
    const rawVal = getRawField(key);
    if (isCreate) {
      result[key] =
        typeof rawVal === 'string'
          ? rawVal.trim()
          : typeof rawVal === 'number'
            ? String(rawVal)
            : '';
    } else if (rawVal !== undefined) {
      result[key] =
        rawVal === null
          ? null
          : typeof rawVal === 'string'
            ? rawVal.trim()
            : typeof rawVal === 'number'
              ? String(rawVal)
              : rawVal;
    }
  }

  const rawSeriesNumber = getRawField('seriesNumber');
  if (isCreate) {
    result.seriesNumber =
      typeof rawSeriesNumber === 'string' || typeof rawSeriesNumber === 'number'
        ? String(rawSeriesNumber).trim()
        : '';
  } else if (rawSeriesNumber !== undefined) {
    result.seriesNumber =
      rawSeriesNumber === null
        ? null
        : typeof rawSeriesNumber === 'string' ||
            typeof rawSeriesNumber === 'number'
          ? String(rawSeriesNumber).trim()
          : rawSeriesNumber;
  }

  if (isCreate) {
    setIfDefined('abstractNote', canonical.rawAbstract ?? '');
  } else if (canonical.rawAbstract !== undefined) {
    const trimmedAbstract =
      canonical.rawAbstract === null
        ? ''
        : String(canonical.rawAbstract).trim();
    result.abstractNote =
      trimmedAbstract === ''
        ? null
        : (cleanAbstractText(canonical.rawAbstract) ?? canonical.rawAbstract);
  }
  setIfDefined('issn', isCreate ? (ids.issn ?? '') : ids.issn);
  setIfDefined('isbn', isCreate ? (ids.isbn ?? '') : ids.isbn);
  setIfDefined('pmid', isCreate ? (ids.pmid ?? '') : ids.pmid);
  setIfDefined('pmcid', isCreate ? (ids.pmcid ?? '') : ids.pmcid);
  setIfDefined('arxivId', isCreate ? (ids.arxivId ?? '') : ids.arxivId);
  setIfDefined(
    'journalAbbr',
    isCreate
      ? (canonical.rawJournalAbbr ?? '').trim()
      : canonical.rawJournalAbbr,
  );
  setIfDefined(
    'rights',
    isCreate ? (canonical.rawRights ?? '').trim() : canonical.rawRights,
  );
  setIfDefined(
    'license',
    isCreate ? (canonical.rawLicense ?? '').trim() : canonical.rawLicense,
  );

  if (isCreate) {
    result.accessedAt =
      data.accessedAt ??
      (canonical.rawAccessDate
        ? parseAccessDate(canonical.rawAccessDate)
        : null);
  } else if (data.accessedAt !== undefined) {
    result.accessedAt = data.accessedAt;
  } else if (canonical.rawAccessDate !== undefined) {
    result.accessedAt =
      parseAccessDate(canonical.rawAccessDate ?? undefined) ?? null;
  }

  setIfDefined('citationCount', formatPositiveCount(data.citationCount));
  setIfDefined('referenceCount', formatPositiveCount(data.referenceCount));
  if (!isCreate && data.isMyPublication !== undefined) {
    result.isMyPublication = data.isMyPublication;
  }

  const { effectiveExtraFields } = canonical;
  const extraPatchWithTombstones: Record<string, unknown> = {
    ...(effectiveExtraFields || {}),
    ...(dataExtra || {}),
  };
  const hasEffectiveExtraPatch =
    Object.keys(extraPatchWithTombstones).length > 0;
  const demotedExtraLines = Array.isArray(dataRecord.demotedExtraLines)
    ? (dataRecord.demotedExtraLines as string[])
    : Array.isArray(dataRecord.__demotedExtraLines)
      ? (dataRecord.__demotedExtraLines as string[])
      : undefined;

  if (isCreate) {
    result.extra =
      resolveExtraPlainText(
        data.extra,
        null,
        extraPatchWithTombstones,
        demotedExtraLines,
      ) ?? '';
    if (uploadedById) result.uploadedById = uploadedById;
  } else if (
    data.extra === null ||
    (typeof data.extra === 'string' &&
      data.extra.trim() === '' &&
      (!demotedExtraLines || demotedExtraLines.length === 0))
  ) {
    result.extra =
      resolveExtraPlainText(
        '',
        null,
        extraPatchWithTombstones,
        demotedExtraLines,
      ) ?? '';
  } else if (
    data.extra !== undefined ||
    hasEffectiveExtraPatch ||
    (demotedExtraLines && demotedExtraLines.length > 0)
  ) {
    const resolvedExtra = resolveExtraPlainText(
      data.extra,
      existingRawExtra,
      extraPatchWithTombstones,
      demotedExtraLines,
    );
    result.extra =
      resolvedExtra !== undefined
        ? resolvedExtra
        : data.extra !== undefined || hasEffectiveExtraPatch
          ? ''
          : (existingRawExtra ?? '');
  }

  if (effectiveExtraFields && typeof effectiveExtraFields === 'object') {
    Object.assign(result, effectiveExtraFields);
  }
  applyMetadataProvenanceAndTelemetry(result, dataRecord, dataExtra, {
    isCreate,
    rawTitle: canonical.rawTitle,
  });
  const directStringSet = new Set<string>(DIRECT_STRING_METADATA_KEYS);
  for (const [k, v] of Object.entries(extraPatchWithTombstones)) {
    if (v === null) {
      if (directStringSet.has(k) && dataRecord[k] === null) {
        result[k] = null;
      } else {
        delete result[k];
      }
    }
  }
  if (data.metadata && typeof data.metadata === 'object') {
    for (const [k, v] of Object.entries(data.metadata)) {
      if (
        v === null &&
        dataRecord[k] === undefined &&
        dataExtra[k] === undefined
      ) {
        delete result[k];
      }
    }
  }
  if (!isCreate && typeof data.extra === 'string' && existingRawExtra) {
    const oldKv = extractExtraKeyValues(existingRawExtra);
    const newKv = extractExtraKeyValues(data.extra);
    for (const [rawKey, oldVal] of Object.entries(oldKv)) {
      if (newKv[rawKey] === undefined) {
        const camelKey = rawKey.replace(/-([a-z])/g, (_, c: string) =>
          c.toUpperCase(),
        );
        if (
          dataRecord[camelKey] === undefined &&
          dataExtra[camelKey] === undefined &&
          String(result[camelKey] ?? '') === oldVal
        ) {
          delete result[camelKey];
        }
      }
    }
  }
  syncMetadataIdentifierAliases(result, ids, {
    isCreate,
    itemType: canonical.itemType,
    rawPubTitle: canonical.rawPubTitle,
    rawPublisher: canonical.rawPublisher,
    rawPlace: canonical.rawPlace,
    rawVolume: canonical.rawVolume,
    rawIssue: canonical.rawIssue,
    rawPages: canonical.rawPages,
    rawAbstract: canonical.rawAbstract,
    rawUrl: canonical.rawUrl,
    suppliedCitationKey: canonical.suppliedCitationKey,
    year: data.year,
    rawPubDate: canonical.rawPubDate,
    rawTypeField: canonical.rawTypeField,
    mappedTypeKey: canonical.baseMap.type || canonical.baseMap.medium,
    baseMap: canonical.baseMap,
    dataRecord,
  });

  const reverseBaseMap = getEffectiveReverseBaseFieldMap(canonical.itemType);
  for (const [tsKey, baseTargets] of Object.entries(
    COUPLED_TYPE_SPECIFIC_TO_BASE,
  )) {
    const rawTsVal = getRawField(tsKey);
    if (rawTsVal === undefined) continue;
    const isCleared =
      rawTsVal === null ||
      (typeof rawTsVal === 'string' && rawTsVal.trim() === '');
    const coupledKeys = Array.from(
      new Set([
        ...baseTargets,
        ...(reverseBaseMap[tsKey] ? [reverseBaseMap[tsKey]] : []),
      ]),
    );
    if (isCleared) {
      result[tsKey] = isCreate ? '' : null;
      for (const bKey of coupledKeys) {
        if (getRawField(bKey) === undefined) {
          result[bKey] = isCreate ? '' : null;
        }
      }
    } else {
      const strVal = String(rawTsVal).trim();
      result[tsKey] = strVal;
      for (const bKey of coupledKeys) {
        if (getRawField(bKey) === undefined) {
          result[bKey] = strVal;
        }
      }
    }
  }
  for (const [baseKey, mappedKey] of Object.entries(canonical.baseMap)) {
    if (!mappedKey) continue;
    const rawBaseVal = getRawField(baseKey);
    if (rawBaseVal !== undefined && getRawField(mappedKey) === undefined) {
      const isCleared =
        rawBaseVal === null ||
        (typeof rawBaseVal === 'string' && rawBaseVal.trim() === '');
      result[mappedKey] = isCleared
        ? isCreate
          ? ''
          : null
        : String(rawBaseVal).trim();
    }
  }

  if (data.editors !== undefined) {
    result.editors = Array.isArray(data.editors) ? data.editors : data.editors === null ? null : [];
  } else if (Array.isArray(data.creators) || Array.isArray(data.contributors)) {
    const rawList = (Array.isArray(data.creators) ? data.creators : data.contributors) as Array<Record<string, unknown>>;
    const editorNames = rawList
      .filter((c) => c && String(c.creatorType || c.role || '').trim().toLowerCase() === 'editor')
      .map((c) => String(c.fullName || c.name || [c.firstName, c.lastName].filter(Boolean).join(' ') || '').trim())
      .filter(Boolean);
    result.editors = editorNames.length > 0 ? editorNames : null;
  }

  if (data.isRetracted !== undefined) {
    result.isRetracted = Boolean(data.isRetracted);
    result.retractionNature = data.retractionNature ?? null;
    result.retractionDetails = data.retractionDetails ?? null;
    result.retractionCheckedAt =
      data.retractionCheckedAt ?? new Date().toISOString();
  } else if (data.retractionCheckedAt !== undefined) {
    result.retractionCheckedAt = data.retractionCheckedAt;
  }
  if (dataRecord.retractionReason !== undefined) {
    const rr = dataRecord.retractionReason;
    result.retractionReason = Array.isArray(rr)
      ? rr.filter(Boolean).join('; ') || null
      : typeof rr === 'string'
        ? rr.trim() || null
        : null;
  }
  if (dataRecord.retractionDate !== undefined) {
    const rd = dataRecord.retractionDate;
    const parsedRd = rd instanceof Date || typeof rd === 'string' ? new Date(rd) : null;
    result.retractionDate =
      parsedRd && !isNaN(parsedRd.getTime()) ? parsedRd.toISOString() : null;
  }
  if (isCreate) {
    if (data.relations) result.relations = data.relations;
    if ('seeAlso' in data && data.seeAlso) result.seeAlso = data.seeAlso;
  }
  return result;
}

export function buildCommandUpdateInput(
  userId: string,
  existing: ItemDetail | Record<string, unknown>,
  data: UpdateItemData,
  options?: { skipVersionIncrement?: boolean },
): {
  updateData: Prisma.ItemUpdateInput;
  cleanIds: ReturnType<typeof normalizeItemIdentifiers>;
  rawTags?: (TagInput | null | undefined)[];
} {
  const dataRecord = data as Record<string, unknown>;
  if (
    typeof dataRecord.author === 'string' &&
    dataRecord.author.trim() &&
    data.creators === undefined &&
    data.contributors === undefined &&
    data.authors === undefined
  ) {
    data = { ...data, authors: [dataRecord.author.trim()] };
  }

  const ids = normalizeItemIdentifiers(data, { preserveOnInvalid: true });
  const targetItemType = (data.itemType ??
    data.type ??
    existing.itemType ??
    existing.type ??
    'journalArticle') as string;
  const rawTags = data.tags || data.keywords || data.labels;

  let existingMeta: Record<string, unknown> = {};
  if (
    existing.metadata &&
    typeof existing.metadata === 'object' &&
    !Array.isArray(existing.metadata)
  ) {
    existingMeta = existing.metadata as Record<string, unknown>;
  } else if (
    typeof existing.metadata === 'string' &&
    existing.metadata.trim().startsWith('{')
  ) {
    try {
      const parsed: unknown = JSON.parse(existing.metadata);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existingMeta = parsed as Record<string, unknown>;
      }
    } catch {
      existingMeta = {};
    }
  }

  const existingRawExtra =
    typeof existing.extra === 'string' && existing.extra.trim()
      ? existing.extra.trim()
      : typeof existingMeta.extra === 'string'
        ? existingMeta.extra.trim()
        : '';

  const canonical = resolveCanonicalCommandFields(data, targetItemType, {});
  const cleanAbstract =
    canonical.rawAbstract !== undefined
      ? canonical.rawAbstract === null || canonical.rawAbstract.trim() === ''
        ? null
        : (cleanAbstractText(canonical.rawAbstract) ?? canonical.rawAbstract)
      : existing.abstract;

  const existingNoteList = existing.notesList || existing.notes;
  const existingProjectId =
    typeof (existing as Record<string, unknown>).projectId === 'string'
      ? ((existing as Record<string, unknown>).projectId as string)
      : null;
  const newNotesToCreate = prepareNotesToCreate(
    data.notes,
    userId,
    data.userId || (existing.uploadedById as string | undefined) || userId,
    existingNoteList,
    existingProjectId,
  );
  const newAttachmentsToCreate =
    Array.isArray(data.attachments) && data.attachments.length > 0
      ? prepareAttachmentsToCreate(
          data.attachments.filter(
            (a: Record<string, unknown> | null | undefined) => !a?.id,
          ),
          null,
          undefined,
          userId,
        )
      : [];

  const updatedMetadata = buildMetadataPartial({
    mode: 'update',
    baseMeta: existingMeta,
    data,
    canonical,
    ids,
    rawTags,
    existingRawExtra,
  });

  const existingContributorsList = (
    Array.isArray(existing.contributors)
      ? existing.contributors
      : Array.isArray(existing.creators)
        ? existing.creators
        : undefined
  ) as Array<Record<string, unknown>> | undefined;

  applyManualEditProvenanceLocks({
    existingMeta,
    dataRecord,
    dataExtra: {
      ...(canonical.effectiveExtraFields || {}),
      ...(data.extraFields &&
      typeof data.extraFields === 'object' &&
      !Array.isArray(data.extraFields)
        ? (data.extraFields as Record<string, unknown>)
        : {}),
    },
    updatedMetadata,
  });

  const existingItemType = (existing.itemType ??
    existing.type ??
    'journalArticle') as string;
  if (existingItemType !== targetItemType) {
    const oldBaseMap = getEffectiveBaseFieldMap(existingItemType);
    const newBaseMap = canonical.baseMap;
    for (const [baseField, oldMappedKey] of Object.entries(oldBaseMap)) {
      const newMappedKey = newBaseMap[baseField];
      if (oldMappedKey && oldMappedKey !== newMappedKey) {
        if (
          newMappedKey &&
          updatedMetadata[newMappedKey] === undefined &&
          updatedMetadata[oldMappedKey] != null
        ) {
          updatedMetadata[newMappedKey] = updatedMetadata[oldMappedKey];
        } else if (
          !newMappedKey &&
          updatedMetadata[baseField] === undefined &&
          updatedMetadata[oldMappedKey] != null
        ) {
          updatedMetadata[baseField] = updatedMetadata[oldMappedKey];
        }
        delete updatedMetadata[oldMappedKey];
      }
    }
    if (targetItemType !== 'journalArticle') delete updatedMetadata.journal;
  }

  const oldPrimaryRole = getPrimaryCreatorRoleForType(existingItemType);
  const newPrimaryRole = getPrimaryCreatorRoleForType(targetItemType);
  const validTargetCreatorMap = getValidCreatorMapForType(targetItemType);
  const hasInvalidCreatorForTargetType =
    existingItemType !== targetItemType &&
    validTargetCreatorMap.size > 0 &&
    Array.isArray(existingContributorsList) &&
    existingContributorsList.some(
      (c) =>
        !validTargetCreatorMap.has(
          String(c.creatorType || c.role || 'author')
            .trim()
            .toLowerCase(),
        ),
    );
  const shouldRemapExistingPrimaryRoles =
    existingItemType !== targetItemType &&
    (oldPrimaryRole !== newPrimaryRole || hasInvalidCreatorForTargetType) &&
    data.creators === undefined &&
    data.contributors === undefined &&
    data.authors === undefined &&
    data.editors === undefined &&
    Array.isArray(existingContributorsList) &&
    existingContributorsList.length > 0;

  const effectiveUpdateDataForCreators = shouldRemapExistingPrimaryRoles
    ? {
        ...data,
        creators: existingContributorsList.map((c) => {
          const currentRole = String(
            c.creatorType || c.role || 'author',
          ).trim();
          const currentLower = currentRole.toLowerCase();
          const isRoleValid =
            validTargetCreatorMap.size === 0 ||
            validTargetCreatorMap.has(currentLower);
          const remappedRole =
            currentRole === oldPrimaryRole ||
            currentRole === 'author' ||
            !isRoleValid
              ? newPrimaryRole
              : validTargetCreatorMap.get(currentLower) || currentRole;
          return { ...c, creatorType: remappedRole, role: remappedRole };
        }),
      }
    : data;

  const contributorsToUpdate = prepareContributorsToCreate(
    effectiveUpdateDataForCreators,
    targetItemType,
    existingContributorsList,
  );
  const collectionItemsPatch = buildCollectionItemsUpdatePatch(data);

  const updateData: Prisma.ItemUpdateInput = {
    title:
      canonical.rawTitle !== undefined
        ? sanitizeItemTitle(canonical.rawTitle) || (existing.title as string)
        : (existing.title as string),
    itemType: targetItemType,
    ...(canonical.rawPubTitle !== undefined
      ? {
          publicationTitle:
            canonical.rawPubTitle === null ||
            canonical.rawPubTitle.trim() === ''
              ? null
              : canonical.rawPubTitle.trim(),
        }
      : {}),
    year: (data.year !== undefined &&
    !(
      canonical.rawPubDate !== undefined &&
      canonical.extractedYear !== null &&
      Number(data.year) === Number(existing.year)
    )
      ? data.year === null || String(data.year).trim() === ''
        ? null
        : Number(data.year)
      : canonical.rawPubDate !== undefined
        ? canonical.extractedYear
        : existing.year) as number | null | undefined,
    doi: (ids.doi !== undefined ? ids.doi || null : existing.doi) as
      | string
      | null
      | undefined,
    abstract: cleanAbstract as string | null | undefined,
    url: (canonical.rawUrl !== undefined
      ? canonical.rawUrl?.trim() || null
      : existing.url) as string | null | undefined,
    citationKey: (canonical.suppliedCitationKey !== undefined
      ? canonical.suppliedCitationKey
      : existing.citationKey) as string | null | undefined,
    metadata: updatedMetadata as Prisma.InputJsonValue,
    ...(contributorsToUpdate !== null
      ? {
          firstAuthor: deriveFirstAuthor({
            contributors: contributorsToUpdate,
            itemType: targetItemType,
          }),
        }
      : data.contributors !== undefined ||
          data.creators !== undefined ||
          data.authors !== undefined ||
          data.editors !== undefined ||
          (data as Record<string, unknown>).author !== undefined
        ? {
            firstAuthor: deriveFirstAuthor({ ...data, itemType: targetItemType }),
          }
        : {}),
    ...(collectionItemsPatch ? { collectionItems: collectionItemsPatch } : {}),
    ...(contributorsToUpdate !== null
      ? { contributors: { deleteMany: {}, create: contributorsToUpdate } }
      : {}),
    ...(newNotesToCreate.length > 0
      ? {
          notesList: { create: newNotesToCreate },
          noteCount:
            (Array.isArray(existingNoteList)
              ? existingNoteList.length
              : typeof existing.noteCount === 'number'
                ? existing.noteCount
                : 0) + newNotesToCreate.length,
        }
      : {}),
    ...(newAttachmentsToCreate.length > 0
      ? {
          attachments: { create: newAttachmentsToCreate },
          attachmentCount:
            (Array.isArray(existing.attachments)
              ? existing.attachments.length
              : typeof existing.attachmentCount === 'number'
                ? existing.attachmentCount
                : 0) + newAttachmentsToCreate.length,
          hasFile: true,
        }
      : {}),
    ...(data.isRetracted !== undefined || data.retractionCheckedAt !== undefined
      ? {
          retractionCheckedAt:
            data.retractionCheckedAt === null && data.isRetracted === undefined
              ? null
              : data.retractionCheckedAt
                ? new Date(data.retractionCheckedAt)
                : new Date(),
        }
      : {}),
    ...(options?.skipVersionIncrement ? {} : { version: { increment: 1 } }),
  };

  return { updateData, cleanIds: ids, rawTags };
}

export const buildUpdateItemPayload = buildCommandUpdateInput;
