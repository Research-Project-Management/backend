import {
  SCHEMA_V42_DATA,
  CANONICAL_BIBLIOGRAPHIC_COLUMN_AND_ALIAS_KEYS,
  FIELD_ALIASES,
  getPrimaryCreatorRoleForType,
  harmonizeZoteroFields,
  isPlaceholderItemTitle,
  LibraryItemSource,
  mergeZoteroExtraTextWithStatus,
  parseCreatorString,
  resolveCanonicalCreatorRole,
  resolveProviderFieldWeight,
  ItemProvenancePolicy,
  FieldProvenanceRecord,
} from '@/modules/library/core';

export const SYSTEM_RESERVED_KEYS = new Set([
  'id', 'userId', 'projectId', 'deletedAt', 'createdAt', 'updatedAt', 'version',
  'citationCount', 'referenceCount', 'crossrefEnriched', 'retractionStatus', 'isRetracted',
]);

const TELEMETRY_ONLY_EXTRA_KEYS = new Set([
  'fieldProvenance', 'lockedFields', 'ingestionStatus', 'verificationScore', 'isVerified',
  'isFilenameTitle', 'qualityScore', 'engineUsed', 'matchedSignals', 'missingFields',
  'isSelfSufficient', 'disambiguationWarning', 'rejectedCitedDoi', 'promptUploadPdf',
  'sourceProvider', 'source', 'sources', 'originProvider', 'canonicalId', 'canonicalUrl',
  'resolvedAt', 'warnings', 'sourceUrl', 'pdfFileId', 'dismissedDuplicateIds', 'mergedFromIds',
]);

export const NON_SCALAR_ENRICH_KEYS = new Set([
  ...SYSTEM_RESERVED_KEYS, 'title', 'authors', 'editors', 'creators', 'contributors',
  'keywords', 'labels', 'tags', 'notes', 'extraFields',
]);

export const SCALAR_METADATA_FIELDS: string[] = Array.from(
  new Set([
    ...SCHEMA_V42_DATA.distinctFieldKeys,
    ...CANONICAL_BIBLIOGRAPHIC_COLUMN_AND_ALIAS_KEYS,
    ...Object.keys(FIELD_ALIASES),
    ...Object.values(FIELD_ALIASES),
  ]),
).filter((key) => !NON_SCALAR_ENRICH_KEYS.has(key));

const CONTROL_ONLY_OVERRIDE_KEYS = new Set(['attachOaPdf', 'saveSnapshot']);

export function sanitizeOverrides(
  overrides?: Record<string, unknown>,
): Record<string, unknown> {
  if (!overrides || typeof overrides !== 'object') return {};
  const clean: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(overrides)) {
    if (!SYSTEM_RESERVED_KEYS.has(key) && !CONTROL_ONLY_OVERRIDE_KEYS.has(key)) {
      clean[key] = val;
    }
  }
  return clean;
}

type CreatorLike = {
  creatorType?: string; role?: string; firstName?: string; lastName?: string; fullName?: string; name?: string; fieldMode?: number;
  contributor?: { creatorType?: string; firstName?: string; lastName?: string; fullName?: string; name?: string; fieldMode?: number };
};

function mergePreservedSecondaryContributors(incomingCreators: unknown[], existingCreatorList: unknown[], itemType: string): unknown[] {
  if (!incomingCreators.length || !existingCreatorList.length) return incomingCreators;
  const primaryRole = getPrimaryCreatorRoleForType(itemType);
  const typedIncoming = incomingCreators as CreatorLike[];
  const preservedSecondary = (existingCreatorList as CreatorLike[]).filter((c) => {
    const role = c?.creatorType || c?.role || c?.contributor?.creatorType || 'author';
    return role !== 'author' && role !== primaryRole;
  });
  if (!preservedSecondary.length) return incomingCreators;
  const result = [...incomingCreators];
  const seenKeys = new Set(
    typedIncoming.map((c) => {
      const role = resolveCanonicalCreatorRole(c?.creatorType || c?.role || 'author', { itemType });
      const full = c?.fullName || c?.name || [c?.firstName, c?.lastName].filter(Boolean).join(' ');
      return `${role}:${String(full || '').toLowerCase()}`;
    }),
  );
  for (const sec of preservedSecondary) {
    const rawRole = sec.creatorType || sec.role || sec.contributor?.creatorType || 'author';
    const role = resolveCanonicalCreatorRole(rawRole, { itemType });
    let firstName = sec.firstName || sec.contributor?.firstName || '';
    let lastName = sec.lastName || sec.contributor?.lastName || '';
    const full = sec.fullName || sec.name || sec.contributor?.fullName || sec.contributor?.name || [firstName, lastName].filter(Boolean).join(' ');
    if (!firstName && !lastName && full) {
      const parsed = parseCreatorString(full, 0, role);
      firstName = parsed.firstName || '';
      lastName = parsed.lastName || '';
    }
    const dedupKey = `${role}:${full.toLowerCase()}`;
    if (full && !seenKeys.has(dedupKey)) {
      seenKeys.add(dedupKey);
      const fieldMode = sec.fieldMode ?? sec.contributor?.fieldMode;
      result.push({ orderIndex: result.length, creatorType: role, firstName, lastName, fullName: full, ...(fieldMode !== undefined ? { fieldMode } : {}) });
    }
  }
  return result;
}

function asObj(val: unknown): Record<string, unknown> {
  return val && typeof val === 'object' && !Array.isArray(val) ? (val as Record<string, unknown>) : {};
}

export function buildEnrichmentPatch(
  existingRec: Record<string, unknown> | null | undefined,
  rawProposed: Record<string, unknown>,
): Record<string, unknown> {
  const resolvedType = (typeof rawProposed.itemType === 'string' && rawProposed.itemType) || (typeof existingRec?.itemType === 'string' && existingRec.itemType) || 'journalArticle';
  const p = harmonizeZoteroFields(rawProposed, { itemType: resolvedType, syncExtraFields: true });
  const enrichPatch: Record<string, unknown> = {};

  const existingMetaObj = asObj(existingRec?.metadata);
  const existingExtraObj = asObj(existingRec?.extraFields);
  const pExtraObj = asObj(p.extraFields);

  const metaState = ItemProvenancePolicy.extractProvenanceState(existingMetaObj);
  const extraState = ItemProvenancePolicy.extractProvenanceState(existingExtraObj);
  const existingLockedSet = new Set<string>([
    ...(Array.isArray(existingRec?.lockedFields) ? (existingRec.lockedFields as string[]) : []),
    ...metaState.lockedSet,
    ...extraState.lockedSet,
  ]);

  const existingProvenanceMap: Record<string, FieldProvenanceRecord> = { ...metaState.provenanceMap, ...extraState.provenanceMap };
  const incomingProvenanceMap = asObj(pExtraObj.fieldProvenance) as Record<string, FieldProvenanceRecord>;

  const getExistingFieldAuthority = (fieldKey: string): number => {
    if (existingLockedSet.has(fieldKey) || ItemProvenancePolicy.getCoupledFieldAliases(fieldKey).some((alias) => existingLockedSet.has(alias))) return 1.0;
    const coupled = ItemProvenancePolicy.getCoupledFieldAliases(fieldKey);
    const prov = existingProvenanceMap[fieldKey] ?? coupled.map((alias) => existingProvenanceMap[alias]).find(Boolean);
    if (!prov) {
      if (fieldKey === 'title' && (existingExtraObj.isFilenameTitle === true || existingMetaObj.isFilenameTitle === true)) return 0.25;
      const fallbackEngine =
        (typeof existingExtraObj.engineUsed === 'string' && existingExtraObj.engineUsed) ||
        (typeof existingMetaObj.engineUsed === 'string' && existingMetaObj.engineUsed) ||
        (typeof existingExtraObj.sourceProvider === 'string' && existingExtraObj.sourceProvider) ||
        (typeof existingMetaObj.sourceProvider === 'string' && existingMetaObj.sourceProvider) ||
        (typeof existingExtraObj.source === 'string' && existingExtraObj.source) ||
        (typeof existingMetaObj.source === 'string' && existingMetaObj.source) ||
        (typeof existingRec?.source === 'string' && existingRec.source) ||
        undefined;
      return fallbackEngine
        ? resolveProviderFieldWeight(fallbackEngine, fieldKey) * 0.9
        : 0.5;
    }
    if (prov.isUserOverride || prov.source === 'UserOverride' || prov.source === 'manual') return 1.0;
    const baseWeight = resolveProviderFieldWeight(prov.sourceProvider || prov.source, fieldKey);
    const conf = typeof prov.confidence === 'number' ? prov.confidence : 0.9;
    return baseWeight * conf;
  };

  const getIncomingFieldAuthority = (fieldKey: string): number => {
    const coupled = ItemProvenancePolicy.getCoupledFieldAliases(fieldKey);
    const prov = incomingProvenanceMap[fieldKey] ?? coupled.map((alias) => incomingProvenanceMap[alias]).find(Boolean);
    if (prov) {
      const baseWeight = resolveProviderFieldWeight(prov.sourceProvider || prov.source, fieldKey);
      const conf = typeof prov.confidence === 'number' ? prov.confidence : 0.9;
      return baseWeight * conf;
    }
    const candidateSource =
      (typeof pExtraObj.engineUsed === 'string' && pExtraObj.engineUsed) ||
      (typeof rawProposed.sourceProvider === 'string' && rawProposed.sourceProvider) ||
      (typeof pExtraObj.sourceProvider === 'string' && pExtraObj.sourceProvider) ||
      (typeof rawProposed.source === 'string' && rawProposed.source) ||
      undefined;
    return candidateSource
      ? resolveProviderFieldWeight(candidateSource, fieldKey) * 0.9
      : 0.5;
  };

  const isFieldLockedByUser = (fieldKey: string): boolean => {
    const coupled = ItemProvenancePolicy.getCoupledFieldAliases(fieldKey);
    if (existingLockedSet.has(fieldKey) || coupled.some((alias) => existingLockedSet.has(alias))) return true;
    const prov = existingProvenanceMap[fieldKey] ?? coupled.map((alias) => existingProvenanceMap[alias]).find(Boolean);
    return Boolean(prov?.isUserOverride || prov?.source === 'UserOverride' || prov?.source === 'manual');
  };

  const canUpgradeExistingField = (fieldKey: string): boolean => {
    if (isFieldLockedByUser(fieldKey)) return false;
    const existingAuth = getExistingFieldAuthority(fieldKey);
    if (existingAuth >= 0.95) return false;
    return getIncomingFieldAuthority(fieldKey) > existingAuth + 0.02;
  };

  const maybeEnrich = (field: string, val: unknown) => {
    if (val == null || val === '' || isFieldLockedByUser(field)) return;
    const current =
      existingRec?.[field] !== undefined
        ? existingRec[field]
        : existingExtraObj[field] !== undefined
          ? existingExtraObj[field]
          : existingMetaObj[field];
    const isEmpty =
      current == null || current === '' || (Array.isArray(current) && current.length === 0);
    if (isEmpty || (current !== val && canUpgradeExistingField(field))) {
      enrichPatch[field] = val;
    }
  };

  if (p.title && !isPlaceholderItemTitle(p.title) && !isFieldLockedByUser('title')) {
    const rawCurrentTitle = existingRec?.title;
    const currentTitle = (
      typeof rawCurrentTitle === 'string' || typeof rawCurrentTitle === 'number'
        ? String(rawCurrentTitle)
        : ''
    ).trim();
    const isCurrentGeneric =
      isPlaceholderItemTitle(currentTitle) ||
      existingExtraObj.isFilenameTitle === true ||
      existingMetaObj.isFilenameTitle === true;
    if (
      isCurrentGeneric ||
      (currentTitle !== String(p.title).trim() && canUpgradeExistingField('title'))
    ) {
      enrichPatch['title'] = p.title;
    }
  }

  for (const field of SCALAR_METADATA_FIELDS) {
    if (field === 'extra') {
      const existingExtraText =
        typeof existingRec?.extra === 'string' && existingRec.extra.trim()
          ? existingRec.extra
          : typeof existingExtraObj.extra === 'string' && existingExtraObj.extra.trim()
            ? existingExtraObj.extra
            : typeof existingMetaObj.extra === 'string' && existingMetaObj.extra.trim()
              ? existingMetaObj.extra
              : '';
      if (
        existingExtraText.length > 0 &&
        typeof p.extra === 'string' &&
        p.extra.trim().length > 0
      ) {
        const { merged, addedNewLine } = mergeZoteroExtraTextWithStatus(existingExtraText, p.extra);
        if (addedNewLine) enrichPatch['extra'] = merged;
        continue;
      }
    }
    maybeEnrich(field, p[field]);
  }

  if (Object.keys(pExtraObj).length > 0) {
    const mergedExtra: Record<string, unknown> = {
      ...existingMetaObj,
      ...existingExtraObj,
    };
    let extraChanged = false;
    for (const [efKey, efVal] of Object.entries(pExtraObj)) {
      if (
        efVal == null ||
        efVal === '' ||
        efKey === 'fieldProvenance' ||
        efKey === 'lockedFields' ||
        isFieldLockedByUser(efKey)
      ) {
        continue;
      }
      if (
        mergedExtra[efKey] == null ||
        mergedExtra[efKey] === '' ||
        (mergedExtra[efKey] !== efVal && canUpgradeExistingField(efKey))
      ) {
        mergedExtra[efKey] = efVal;
        extraChanged = true;
      }
      if (!TELEMETRY_ONLY_EXTRA_KEYS.has(efKey)) {
        maybeEnrich(efKey, efVal);
      }
    }
    if (extraChanged) {
      enrichPatch['extraFields'] = mergedExtra;
    }
  }

  const existingCreators = (existingRec?.creators || existingRec?.contributors) as
    | unknown[]
    | undefined;
  const existingAuthors = (existingRec?.authors || existingCreators) as
    | unknown[]
    | undefined;
  const existingEditors = existingRec?.editors as unknown[] | undefined;
  const existingKeywords = (existingRec?.keywords ||
    existingRec?.labels ||
    existingRec?.tags ||
    existingRec?.itemTags) as unknown[] | undefined;

  const pAuthors = p.authors as unknown[] | undefined;
  const pEditors = p.editors as unknown[] | undefined;
  const pCreators = p.creators as unknown[] | undefined;
  const pKeywords = (p.keywords || p.tags) as unknown[] | undefined;

  if (
    pAuthors?.length &&
    !isFieldLockedByUser('authors') &&
    (!existingAuthors?.length || canUpgradeExistingField('authors'))
  ) {
    enrichPatch['authors'] = pAuthors;
  }
  if (
    pEditors?.length &&
    !isFieldLockedByUser('editors') &&
    (!existingEditors?.length || canUpgradeExistingField('editors'))
  ) {
    enrichPatch['editors'] = pEditors;
  }
  if (
    pCreators?.length &&
    !isFieldLockedByUser('creators') &&
    (!existingCreators?.length || canUpgradeExistingField('creators'))
  ) {
    const existingCreatorList = [
      ...(Array.isArray(existingRec?.creators) ? existingRec.creators : []),
      ...(Array.isArray(existingRec?.contributors) ? existingRec.contributors : []),
    ];
    enrichPatch['creators'] = mergePreservedSecondaryContributors(
      pCreators,
      existingCreatorList,
      resolvedType,
    );
  }
  if (pKeywords?.length && !isFieldLockedByUser('tags')) {
    const extractTagStr = (entry: unknown): string => {
      if (typeof entry === 'string') return entry.trim();
      if (entry && typeof entry === 'object') {
        const obj = entry as { tag?: unknown; name?: unknown; label?: unknown };
        const nested =
          obj.tag && typeof obj.tag === 'object'
            ? (obj.tag as { name?: unknown }).name
            : obj.tag;
        const raw = nested ?? obj.name ?? obj.label;
        if (typeof raw === 'string') return raw.trim();
      }
      return '';
    };
    const existingTagStrings = (existingKeywords ?? []).map(extractTagStr).filter(Boolean);
    const incomingTagStrings = pKeywords.map(extractTagStr).filter(Boolean);
    const seenLower = new Set(existingTagStrings.map((t) => t.toLowerCase()));
    const mergedKeywords = [...existingTagStrings];
    let addedNewKeyword = false;
    for (const kw of incomingTagStrings) {
      const lower = kw.toLowerCase();
      if (!seenLower.has(lower)) {
        seenLower.add(lower);
        mergedKeywords.push(kw);
        addedNewKeyword = true;
      }
    }
    if (addedNewKeyword || (!existingTagStrings.length && mergedKeywords.length > 0)) {
      const cappedKeywords = mergedKeywords.slice(0, 25);
      enrichPatch['keywords'] = cappedKeywords;
      enrichPatch['labels'] = cappedKeywords;
    }
  }
  if (typeof rawProposed.isRetracted === 'boolean' && !isFieldLockedByUser('isRetracted')) {
    if (rawProposed.isRetracted === true || existingRec?.isRetracted == null) {
      enrichPatch['isRetracted'] = rawProposed.isRetracted;
    }
  }
  if (typeof rawProposed.citationCount === 'number' && !isFieldLockedByUser('citationCount')) {
    if (existingRec?.citationCount == null || rawProposed.citationCount > Number(existingRec.citationCount)) {
      enrichPatch['citationCount'] = rawProposed.citationCount;
    }
  }
  if (typeof rawProposed.referenceCount === 'number' && !isFieldLockedByUser('referenceCount')) {
    if (existingRec?.referenceCount == null || rawProposed.referenceCount > Number(existingRec.referenceCount)) {
      enrichPatch['referenceCount'] = rawProposed.referenceCount;
    }
  }

  const enrichedFieldKeys = Object.keys(enrichPatch).filter(
    (k) => k !== 'extraFields' && !k.startsWith('__'),
  );
  if (enrichedFieldKeys.length > 0 || enrichPatch['extraFields'] !== undefined) {
    const candidateSource =
      (typeof pExtraObj.engineUsed === 'string' && pExtraObj.engineUsed) ||
      (typeof rawProposed.sourceProvider === 'string' && rawProposed.sourceProvider) ||
      undefined;
    const nextProvMap: Record<string, FieldProvenanceRecord> = {
      ...existingProvenanceMap,
    };
    let provUpdated = false;
    for (const fKey of enrichedFieldKeys) {
      if (isFieldLockedByUser(fKey)) continue;
      const coupledAliases = ItemProvenancePolicy.getCoupledFieldAliases(fKey);
      const incomingProv =
        incomingProvenanceMap[fKey] ??
        coupledAliases.map((alias) => incomingProvenanceMap[alias]).find(Boolean);
      const stampedProv: FieldProvenanceRecord | undefined = incomingProv
        ? {
            ...incomingProv,
            ...(fKey === 'title' ? { isFilenameTitle: false } : {}),
          }
        : candidateSource
          ? {
              source: candidateSource,
              sourceProvider: candidateSource,
              confidence: 0.9,
              verified: Boolean(pExtraObj.isVerified ?? true),
              ...(fKey === 'title' ? { isFilenameTitle: false } : {}),
            }
          : undefined;
      if (stampedProv) {
        nextProvMap[fKey] = stampedProv;
        for (const alias of coupledAliases) {
          if (!isFieldLockedByUser(alias)) {
            nextProvMap[alias] = stampedProv;
          }
        }
        provUpdated = true;
      }
    }
    if (provUpdated || enrichPatch['title'] !== undefined) {
      const targetExtra =
        enrichPatch['extraFields'] && typeof enrichPatch['extraFields'] === 'object'
          ? (enrichPatch['extraFields'] as Record<string, unknown>)
          : { ...existingMetaObj, ...existingExtraObj };
      if (provUpdated) {
        targetExtra.fieldProvenance = nextProvMap;
      }
      if (enrichPatch['title'] !== undefined) {
        targetExtra.isFilenameTitle = false;
      }
      enrichPatch['extraFields'] = targetExtra;
    }
    enrichPatch.__isSystemUpdate = true;
    enrichPatch.__updateSource = 'ingestion.enrich';
  }

  return enrichPatch;
}

export function buildReResolvePatch(
  existingRec: Record<string, unknown>,
  resolvedMetadata: Record<string, unknown>,
  options?: { fields?: string[]; lockedFields?: string[] },
): { updateData: Record<string, unknown>; updatedFields: string[] } {
  const effectiveItemType =
    (typeof resolvedMetadata.itemType === 'string' && resolvedMetadata.itemType) ||
    (typeof existingRec.itemType === 'string' && existingRec.itemType) ||
    (typeof existingRec.type === 'string' && existingRec.type) ||
    'journalArticle';
  const rawExtra = asObj(resolvedMetadata.extraFields);
  const m: Record<string, unknown> = harmonizeZoteroFields(
    { ...resolvedMetadata, extraFields: { ...rawExtra } },
    { itemType: effectiveItemType, syncExtraFields: true },
  );

  const updateData: Record<string, unknown> = {};
  const updatedFields: string[] = [];
  const allowedFieldSet =
    Array.isArray(options?.fields) && options.fields.length > 0 ? new Set(options.fields) : null;

  const existingExtraObj = asObj(existingRec.extraFields);
  const existingMetaObj = asObj(existingRec.metadata);
  const mExtraObj = asObj(m.extraFields);
  const resolvedSource =
    (typeof mExtraObj.engineUsed === 'string' && mExtraObj.engineUsed) ||
    (typeof resolvedMetadata.sourceProvider === 'string' && resolvedMetadata.sourceProvider) ||
    (typeof resolvedMetadata.source === 'string' && resolvedMetadata.source) ||
    'CrossRef';
  const metaState = ItemProvenancePolicy.extractProvenanceState(existingMetaObj);
  const extraState = ItemProvenancePolicy.extractProvenanceState(existingExtraObj);
  const existingProvMap: Record<string, FieldProvenanceRecord> = {
    ...metaState.provenanceMap,
    ...extraState.provenanceMap,
  };
  const incomingProvMap = asObj(mExtraObj.fieldProvenance) as Record<string, FieldProvenanceRecord>;
  const lockedFieldSet = new Set<string>([
    ...(Array.isArray(options?.lockedFields) ? options.lockedFields : []),
    ...(Array.isArray(existingRec.lockedFields) ? (existingRec.lockedFields as string[]) : []),
    ...metaState.lockedSet,
    ...extraState.lockedSet,
  ]);

  const getExistingValue = (fieldName: string): unknown => {
    const coupled = ItemProvenancePolicy.getCoupledFieldAliases(fieldName);
    for (const k of [fieldName, ...coupled]) {
      for (const container of [existingRec, existingExtraObj, existingMetaObj]) {
        const v = container[k];
        if (v !== undefined && v !== null && v !== '') {
          if (!Array.isArray(v) || v.length > 0) return v;
        }
      }
    }
    return undefined;
  };

  const getExistingProvAuthority = (fieldKey: string): number => {
    if (
      fieldKey === 'title' &&
      (existingExtraObj.isFilenameTitle === true || existingMetaObj.isFilenameTitle === true)
    ) {
      return 0.25;
    }
    const coupled = ItemProvenancePolicy.getCoupledFieldAliases(fieldKey);
    const prov = existingProvMap[fieldKey] ?? coupled.map((a) => existingProvMap[a]).find(Boolean);
    if (!prov) return 0;
    const src = prov.sourceProvider || prov.source;
    if (!src) return 0;
    const conf = typeof prov.confidence === 'number' ? prov.confidence : 0.9;
    return resolveProviderFieldWeight(src, fieldKey) * conf;
  };

  const getIncomingProvAuthority = (fieldKey: string): number => {
    const coupled = ItemProvenancePolicy.getCoupledFieldAliases(fieldKey);
    const prov = incomingProvMap[fieldKey] ?? coupled.map((a) => incomingProvMap[a]).find(Boolean);
    if (prov) {
      const src = prov.sourceProvider || prov.source || resolvedSource;
      const conf = typeof prov.confidence === 'number' ? prov.confidence : 0.95;
      return resolveProviderFieldWeight(src, fieldKey) * conf;
    }
    return resolveProviderFieldWeight(resolvedSource, fieldKey) * 0.95;
  };

  const applyField = (fieldName: string, value: unknown) => {
    const coupled = ItemProvenancePolicy.getCoupledFieldAliases(fieldName);
    if (lockedFieldSet.has(fieldName) || coupled.some((alias) => lockedFieldSet.has(alias))) return;
    if (allowedFieldSet && !allowedFieldSet.has(fieldName)) return;
    if (!allowedFieldSet) {
      const existingVal = getExistingValue(fieldName);
      if (existingVal !== undefined) {
        if (
          (fieldName === 'publicationTitle' || fieldName === 'journal' || fieldName === 'venue') &&
          typeof existingVal === 'string' &&
          !/^arxiv(\s+e-?prints)?$/i.test(existingVal.trim()) &&
          typeof value === 'string' &&
          /^arxiv(\s+e-?prints)?$/i.test(value.trim())
        ) {
          return;
        }
        const existingAuth = getExistingProvAuthority(fieldName);
        const incomingAuth = getIncomingProvAuthority(fieldName);
        if (existingAuth > 0 && incomingAuth + 0.05 < existingAuth) return;
      }
    }
    if (value !== undefined && value !== null && value !== '') {
      updateData[fieldName] = value;
      if (!updatedFields.includes(fieldName)) updatedFields.push(fieldName);
    }
  };

  if (m.title && !isPlaceholderItemTitle(String(m.title)) && m.title !== existingRec.title) {
    applyField('title', m.title);
  }

  const primaryRole = getPrimaryCreatorRoleForType(effectiveItemType);
  let resolvedCreators: Array<{
    orderIndex: number; creatorType: string; firstName: string; lastName: string; fullName: string; fieldMode?: number;
  }> | undefined;

  if (Array.isArray(m.creators) && m.creators.length > 0) {
    resolvedCreators = (m.creators as Array<CreatorLike>).map((c, index) => ({
      orderIndex: index,
      creatorType: resolveCanonicalCreatorRole(c.creatorType, { itemType: effectiveItemType }),
      firstName: c.firstName || '',
      lastName: c.lastName || '',
      fullName: c.fullName || c.name || [c.firstName, c.lastName].filter(Boolean).join(' '),
      ...(c.fieldMode !== undefined ? { fieldMode: c.fieldMode } : {}),
    }));
  } else if (Array.isArray(m.authors) && m.authors.length > 0) {
    resolvedCreators = (m.authors as string[]).map((authorStr: string, index: number) => {
      const parsed = parseCreatorString(authorStr, index, primaryRole);
      return {
        orderIndex: index,
        creatorType: primaryRole,
        firstName: parsed.firstName || '',
        lastName: parsed.lastName || '',
        fullName: parsed.fullName || authorStr,
        ...(parsed.fieldMode !== undefined ? { fieldMode: parsed.fieldMode } : {}),
      };
    });
  }

  if (resolvedCreators && resolvedCreators.length > 0) {
    const existingCreatorList = [
      ...(Array.isArray(existingRec.creators) ? existingRec.creators : []),
      ...(Array.isArray(existingRec.contributors) ? existingRec.contributors : []),
    ];
    applyField('creators', mergePreservedSecondaryContributors(resolvedCreators, existingCreatorList, effectiveItemType));
  }

  if (m.publicationDate) {
    applyField('date', m.publicationDate);
    applyField('publicationDate', m.publicationDate);
  } else if (m.year) {
    applyField('date', String(m.year));
  }
  if (m.year) applyField('year', m.year);
  if (m.journal || m.publicationTitle) applyField('publicationTitle', m.journal || m.publicationTitle);
  if (m.abstract || m.abstractNote) {
    applyField('abstractNote', m.abstract || m.abstractNote);
    applyField('abstract', m.abstract || m.abstractNote);
  }

  const existingTags = (existingRec.tags || existingRec.keywords || existingRec.labels || existingRec.itemTags) as unknown[] | undefined;
  const resolvedTags = (m.tags || m.keywords || m.labels) as unknown[] | undefined;
  if (Array.isArray(resolvedTags) && resolvedTags.length > 0 && (!Array.isArray(existingTags) || existingTags.length === 0)) {
    applyField('tags', resolvedTags);
  }

  const handledKeys = new Set([
    'title', 'creators', 'authors', 'editors', 'contributors', 'publicationDate', 'date', 'year',
    'publicationTitle', 'journal', 'abstract', 'abstractNote', 'tags', 'keywords', 'labels',
    'itemTags', 'zoteroTags', 'extraFields', 'notes', 'provenance',
  ]);

  for (const [key, val] of Object.entries(m)) {
    if (handledKeys.has(key) || TELEMETRY_ONLY_EXTRA_KEYS.has(key)) continue;
    if (val === undefined || val === null || val === '' || (Array.isArray(val) && val.length === 0)) continue;
    if (key === 'extra' && typeof val === 'string') {
      const existingExtraText =
        typeof existingRec.extra === 'string' && existingRec.extra.trim()
          ? existingRec.extra
          : typeof existingExtraObj.extra === 'string' && existingExtraObj.extra.trim()
            ? existingExtraObj.extra
            : typeof existingMetaObj.extra === 'string' && existingMetaObj.extra.trim()
              ? existingMetaObj.extra
              : '';
      if (existingExtraText.length > 0) {
        const { merged } = mergeZoteroExtraTextWithStatus(existingExtraText, val);
        applyField('extra', merged);
        continue;
      }
    }
    applyField(key, val);
  }

  const mExtra = Object.keys(mExtraObj).length > 0 ? mExtraObj : undefined;
  const mergedExtraFields: Record<string, unknown> = { ...existingMetaObj, ...existingExtraObj };
  let extraModified = false;
  if (mExtra) {
    for (const [efKey, efVal] of Object.entries(mExtra)) {
      if (lockedFieldSet.has(efKey) || efKey === 'lockedFields') continue;
      if (efVal !== undefined && efVal !== null && efVal !== '') {
        mergedExtraFields[efKey] = efVal;
        extraModified = true;
        if (!TELEMETRY_ONLY_EXTRA_KEYS.has(efKey)) applyField(efKey, efVal);
      }
    }
  }

  if (updatedFields.length > 0) {
    const nextProvMap: Record<string, FieldProvenanceRecord> = {
      ...existingProvMap,
      ...incomingProvMap,
    };
    for (const fKey of updatedFields) {
      if (lockedFieldSet.has(fKey) || TELEMETRY_ONLY_EXTRA_KEYS.has(fKey)) continue;
      if (!incomingProvMap[fKey]) {
        nextProvMap[fKey] = {
          source: resolvedSource,
          sourceProvider: resolvedSource,
          confidence: 0.95,
          verified: true,
          ...(fKey === 'title' ? { isFilenameTitle: false } : {}),
        };
      }
    }
    mergedExtraFields.fieldProvenance = nextProvMap;
    if (updatedFields.includes('title')) mergedExtraFields.isFilenameTitle = false;
    updateData.extraFields = mergedExtraFields;
    updateData.__isSystemUpdate = true;
    updateData.__updateSource = 'ingestion.re_resolve';
  } else if (extraModified) {
    updateData.extraFields = mergedExtraFields;
  }

  return { updateData, updatedFields };
}

export function mapPayloadToSource(kind: string): LibraryItemSource {
  switch (kind) {
    case 'IDENTIFIER':
      return 'doi';
    case 'RECORD':
      return 'bibtex';
    case 'URL':
      return 'url';
    case 'FILE':
      return 'pdf';
    case 'CONNECTOR':
      return 'external_sync';
    default:
      return 'manual';
  }
}
