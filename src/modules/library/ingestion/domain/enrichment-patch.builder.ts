import {
  SCHEMA_V42_DATA, CANONICAL_BIBLIOGRAPHIC_COLUMN_AND_ALIAS_KEYS, FIELD_ALIASES,
  getPrimaryCreatorRoleForType, harmonizeZoteroFields, isPlaceholderItemTitle,
  LibraryItemSource, mergeZoteroExtraTextWithStatus, parseCreatorString,
  resolveCanonicalCreatorRole, resolveProviderFieldWeight, ItemProvenancePolicy,
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
    ...SCHEMA_V42_DATA.distinctFieldKeys, ...CANONICAL_BIBLIOGRAPHIC_COLUMN_AND_ALIAS_KEYS,
    ...Object.keys(FIELD_ALIASES), ...Object.values(FIELD_ALIASES),
  ]),
).filter((key) => !NON_SCALAR_ENRICH_KEYS.has(key));

const CONTROL_ONLY_OVERRIDE_KEYS = new Set(['attachOaPdf', 'saveSnapshot']);

export function sanitizeOverrides(overrides?: Record<string, unknown>): Record<string, unknown> {
  if (!overrides || typeof overrides !== 'object') return {};
  const clean: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(overrides)) {
    if (!SYSTEM_RESERVED_KEYS.has(key) && !CONTROL_ONLY_OVERRIDE_KEYS.has(key)) clean[key] = val;
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
  const preservedSecondary = (existingCreatorList as CreatorLike[]).filter((c) => {
    const role = c?.creatorType || c?.role || c?.contributor?.creatorType || 'author';
    return role !== 'author' && role !== primaryRole;
  });
  if (!preservedSecondary.length) return incomingCreators;
  const result = [...incomingCreators];
  const seenKeys = new Set(
    (incomingCreators as CreatorLike[]).map((c) => {
      const role = resolveCanonicalCreatorRole(c?.creatorType || c?.role || 'author', { itemType });
      const full = c?.fullName || c?.name || [c?.firstName, c?.lastName].filter(Boolean).join(' ');
      return `${role}:${String(full || '').toLowerCase()}`;
    }),
  );
  for (const sec of preservedSecondary) {
    const role = resolveCanonicalCreatorRole(sec.creatorType || sec.role || sec.contributor?.creatorType || 'author', { itemType });
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

function pickFirstString(...vals: unknown[]): string | undefined {
  for (const v of vals) if (typeof v === 'string' && v) return v;
  return undefined;
}

function resolveExistingExtraText(
  existingRec: Record<string, unknown> | null | undefined,
  existingExtraObj: Record<string, unknown>,
  existingMetaObj: Record<string, unknown>,
): string {
  for (const cand of [existingRec?.extra, existingExtraObj.extra, existingMetaObj.extra]) {
    if (typeof cand === 'string' && cand.trim()) return cand;
  }
  return '';
}

function extractTagStr(entry: unknown): string {
  if (typeof entry === 'string') return entry.trim();
  if (entry && typeof entry === 'object') {
    const obj = entry as { tag?: unknown; name?: unknown; label?: unknown };
    const nested = obj.tag && typeof obj.tag === 'object' ? (obj.tag as { name?: unknown }).name : obj.tag;
    const raw = nested ?? obj.name ?? obj.label;
    if (typeof raw === 'string') return raw.trim();
  }
  return '';
}

function buildPatchProvenanceContext(
  existingRec: Record<string, unknown> | null | undefined,
  incomingExtraObj: Record<string, unknown>,
  extraLockedFields?: string[],
) {
  const existingMetaObj = asObj(existingRec?.metadata);
  const existingExtraObj = asObj(existingRec?.extraFields);
  const metaState = ItemProvenancePolicy.extractProvenanceState(existingMetaObj);
  const extraState = ItemProvenancePolicy.extractProvenanceState(existingExtraObj);
  const lockedSet = new Set<string>([
    ...(Array.isArray(extraLockedFields) ? extraLockedFields : []),
    ...(Array.isArray(existingRec?.lockedFields) ? (existingRec.lockedFields as string[]) : []),
    ...metaState.lockedSet, ...extraState.lockedSet,
  ]);
  const existingProvMap: Record<string, FieldProvenanceRecord> = { ...metaState.provenanceMap, ...extraState.provenanceMap };
  const incomingProvMap = asObj(incomingExtraObj.fieldProvenance) as Record<string, FieldProvenanceRecord>;
  const isFilenameTitle = existingExtraObj.isFilenameTitle === true || existingMetaObj.isFilenameTitle === true;

  const findProv = (map: Record<string, FieldProvenanceRecord>, fieldKey: string): FieldProvenanceRecord | undefined => {
    const coupled = ItemProvenancePolicy.getCoupledFieldAliases(fieldKey);
    return map[fieldKey] ?? coupled.map((alias) => map[alias]).find(Boolean);
  };

  const isFieldLocked = (fieldKey: string): boolean => {
    const coupled = ItemProvenancePolicy.getCoupledFieldAliases(fieldKey);
    if (lockedSet.has(fieldKey) || coupled.some((alias) => lockedSet.has(alias))) return true;
    const prov = findProv(existingProvMap, fieldKey);
    return Boolean(prov?.isUserOverride || prov?.source === 'UserOverride' || prov?.source === 'manual');
  };

  return { existingMetaObj, existingExtraObj, lockedSet, existingProvMap, incomingProvMap, isFilenameTitle, findProv, isFieldLocked };
}

export function buildEnrichmentPatch(
  existingRec: Record<string, unknown> | null | undefined,
  rawProposed: Record<string, unknown>,
): Record<string, unknown> {
  const resolvedType = pickFirstString(rawProposed.itemType, existingRec?.itemType) || 'journalArticle';
  const p = harmonizeZoteroFields(rawProposed, { itemType: resolvedType, syncExtraFields: true });
  const enrichPatch: Record<string, unknown> = {};
  const pExtraObj = asObj(p.extraFields);
  const { existingMetaObj, existingExtraObj, existingProvMap, incomingProvMap, isFilenameTitle, findProv, isFieldLocked } =
    buildPatchProvenanceContext(existingRec, pExtraObj);

  const getExistingFieldAuthority = (fieldKey: string): number => {
    if (isFieldLocked(fieldKey)) return 1.0;
    const prov = findProv(existingProvMap, fieldKey);
    if (!prov) {
      if (fieldKey === 'title' && isFilenameTitle) return 0.25;
      const fallbackEngine = pickFirstString(
        existingExtraObj.engineUsed, existingMetaObj.engineUsed, existingExtraObj.sourceProvider,
        existingMetaObj.sourceProvider, existingExtraObj.source, existingMetaObj.source, existingRec?.source,
      );
      return fallbackEngine ? resolveProviderFieldWeight(fallbackEngine, fieldKey) * 0.9 : 0.5;
    }
    if (prov.isUserOverride || prov.source === 'UserOverride' || prov.source === 'manual') return 1.0;
    return resolveProviderFieldWeight(prov.sourceProvider || prov.source, fieldKey) * (typeof prov.confidence === 'number' ? prov.confidence : 0.9);
  };

  const getIncomingFieldAuthority = (fieldKey: string): number => {
    const prov = findProv(incomingProvMap, fieldKey);
    if (prov) return resolveProviderFieldWeight(prov.sourceProvider || prov.source, fieldKey) * (typeof prov.confidence === 'number' ? prov.confidence : 0.9);
    const candidateSource = pickFirstString(pExtraObj.engineUsed, rawProposed.sourceProvider, pExtraObj.sourceProvider, rawProposed.source);
    return candidateSource ? resolveProviderFieldWeight(candidateSource, fieldKey) * 0.9 : 0.5;
  };

  const canUpgradeExistingField = (fieldKey: string): boolean => {
    if (isFieldLocked(fieldKey)) return false;
    const existingAuth = getExistingFieldAuthority(fieldKey);
    return existingAuth < 0.95 && getIncomingFieldAuthority(fieldKey) > existingAuth + 0.02;
  };

  const maybeEnrich = (field: string, val: unknown) => {
    if (val == null || val === '' || isFieldLocked(field)) return;
    const current = existingRec?.[field] !== undefined ? existingRec[field] : existingExtraObj[field] !== undefined ? existingExtraObj[field] : existingMetaObj[field];
    const isEmpty = current == null || current === '' || (Array.isArray(current) && current.length === 0);
    if (isEmpty || (current !== val && canUpgradeExistingField(field))) enrichPatch[field] = val;
  };

  if (p.title && !isPlaceholderItemTitle(p.title) && !isFieldLocked('title')) {
    const rawCurrentTitle = existingRec?.title;
    const currentTitle = (typeof rawCurrentTitle === 'string' || typeof rawCurrentTitle === 'number' ? String(rawCurrentTitle) : '').trim();
    if (isPlaceholderItemTitle(currentTitle) || isFilenameTitle || (currentTitle !== String(p.title).trim() && canUpgradeExistingField('title'))) {
      enrichPatch['title'] = p.title;
    }
  }

  for (const field of SCALAR_METADATA_FIELDS) {
    if (field === 'extra') {
      const existingExtraText = resolveExistingExtraText(existingRec, existingExtraObj, existingMetaObj);
      if (existingExtraText.length > 0 && typeof p.extra === 'string' && p.extra.trim().length > 0) {
        const { merged, addedNewLine } = mergeZoteroExtraTextWithStatus(existingExtraText, p.extra);
        if (addedNewLine) enrichPatch['extra'] = merged;
        continue;
      }
    }
    maybeEnrich(field, p[field]);
  }

  if (Object.keys(pExtraObj).length > 0) {
    const mergedExtra: Record<string, unknown> = { ...existingMetaObj, ...existingExtraObj };
    let extraChanged = false;
    for (const [efKey, efVal] of Object.entries(pExtraObj)) {
      if (efVal == null || efVal === '' || efKey === 'fieldProvenance' || efKey === 'lockedFields' || isFieldLocked(efKey)) continue;
      if (mergedExtra[efKey] == null || mergedExtra[efKey] === '' || (mergedExtra[efKey] !== efVal && canUpgradeExistingField(efKey))) {
        mergedExtra[efKey] = efVal;
        extraChanged = true;
      }
      if (!TELEMETRY_ONLY_EXTRA_KEYS.has(efKey)) maybeEnrich(efKey, efVal);
    }
    if (extraChanged) enrichPatch['extraFields'] = mergedExtra;
  }

  const existingCreators = (existingRec?.creators || existingRec?.contributors) as unknown[] | undefined;
  const existingAuthors = (existingRec?.authors || existingCreators) as unknown[] | undefined;
  const existingEditors = existingRec?.editors as unknown[] | undefined;
  const existingKeywords = (existingRec?.keywords || existingRec?.labels || existingRec?.tags || existingRec?.itemTags) as unknown[] | undefined;
  const pAuthors = p.authors as unknown[] | undefined;
  const pEditors = p.editors as unknown[] | undefined;
  const pCreators = p.creators as unknown[] | undefined;
  const pKeywords = (p.keywords || p.tags) as unknown[] | undefined;

  if (pAuthors?.length && !isFieldLocked('authors') && (!existingAuthors?.length || canUpgradeExistingField('authors'))) enrichPatch['authors'] = pAuthors;
  if (pEditors?.length && !isFieldLocked('editors') && (!existingEditors?.length || canUpgradeExistingField('editors'))) enrichPatch['editors'] = pEditors;
  if (pCreators?.length && !isFieldLocked('creators') && (!existingCreators?.length || canUpgradeExistingField('creators'))) {
    const existingCreatorList = [...(Array.isArray(existingRec?.creators) ? existingRec.creators : []), ...(Array.isArray(existingRec?.contributors) ? existingRec.contributors : [])];
    enrichPatch['creators'] = mergePreservedSecondaryContributors(pCreators, existingCreatorList, resolvedType);
  }
  if (pKeywords?.length && !isFieldLocked('tags')) {
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
  if (typeof rawProposed.isRetracted === 'boolean' && !isFieldLocked('isRetracted')) {
    if (rawProposed.isRetracted === true || existingRec?.isRetracted == null) enrichPatch['isRetracted'] = rawProposed.isRetracted;
  }
  if (typeof rawProposed.citationCount === 'number' && !isFieldLocked('citationCount')) {
    if (existingRec?.citationCount == null || rawProposed.citationCount > Number(existingRec.citationCount)) enrichPatch['citationCount'] = rawProposed.citationCount;
  }
  if (typeof rawProposed.referenceCount === 'number' && !isFieldLocked('referenceCount')) {
    if (existingRec?.referenceCount == null || rawProposed.referenceCount > Number(existingRec.referenceCount)) enrichPatch['referenceCount'] = rawProposed.referenceCount;
  }

  const enrichedFieldKeys = Object.keys(enrichPatch).filter((k) => k !== 'extraFields' && !k.startsWith('__'));
  if (enrichedFieldKeys.length > 0 || enrichPatch['extraFields'] !== undefined) {
    const candidateSource = pickFirstString(pExtraObj.engineUsed, rawProposed.sourceProvider);
    const nextProvMap: Record<string, FieldProvenanceRecord> = { ...existingProvMap };
    let provUpdated = false;
    for (const fKey of enrichedFieldKeys) {
      if (isFieldLocked(fKey)) continue;
      const coupledAliases = ItemProvenancePolicy.getCoupledFieldAliases(fKey);
      const incomingProv = findProv(incomingProvMap, fKey);
      const stampedProv: FieldProvenanceRecord | undefined = incomingProv
        ? { ...incomingProv, ...(fKey === 'title' ? { isFilenameTitle: false } : {}) }
        : candidateSource
          ? { source: candidateSource, sourceProvider: candidateSource, confidence: 0.9, verified: Boolean(pExtraObj.isVerified ?? true), ...(fKey === 'title' ? { isFilenameTitle: false } : {}) }
          : undefined;
      if (stampedProv) {
        nextProvMap[fKey] = stampedProv;
        for (const alias of coupledAliases) if (!isFieldLocked(alias)) nextProvMap[alias] = stampedProv;
        provUpdated = true;
      }
    }
    if (provUpdated || enrichPatch['title'] !== undefined) {
      const targetExtra = enrichPatch['extraFields'] && typeof enrichPatch['extraFields'] === 'object'
        ? (enrichPatch['extraFields'] as Record<string, unknown>) : { ...existingMetaObj, ...existingExtraObj };
      if (provUpdated) targetExtra.fieldProvenance = nextProvMap;
      if (enrichPatch['title'] !== undefined) targetExtra.isFilenameTitle = false;
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
  const effectiveItemType = pickFirstString(resolvedMetadata.itemType, existingRec.itemType, existingRec.type) || 'journalArticle';
  const m: Record<string, unknown> = harmonizeZoteroFields(
    { ...resolvedMetadata, extraFields: { ...asObj(resolvedMetadata.extraFields) } },
    { itemType: effectiveItemType, syncExtraFields: true },
  );

  const updateData: Record<string, unknown> = {};
  const updatedFields: string[] = [];
  const allowedFieldSet = Array.isArray(options?.fields) && options.fields.length > 0 ? new Set(options.fields) : null;
  const mExtraObj = asObj(m.extraFields);
  const resolvedSource = pickFirstString(mExtraObj.engineUsed, resolvedMetadata.sourceProvider, resolvedMetadata.source) || 'CrossRef';
  const { existingMetaObj, existingExtraObj, lockedSet, existingProvMap, incomingProvMap, isFilenameTitle, findProv } =
    buildPatchProvenanceContext(existingRec, mExtraObj, options?.lockedFields);

  const getExistingValue = (fieldName: string): unknown => {
    for (const k of [fieldName, ...ItemProvenancePolicy.getCoupledFieldAliases(fieldName)]) {
      for (const container of [existingRec, existingExtraObj, existingMetaObj]) {
        const v = container[k];
        if (v !== undefined && v !== null && v !== '' && (!Array.isArray(v) || v.length > 0)) return v;
      }
    }
    return undefined;
  };

  const getExistingProvAuthority = (fieldKey: string): number => {
    if (fieldKey === 'title' && isFilenameTitle) return 0.25;
    const prov = findProv(existingProvMap, fieldKey);
    const src = prov?.sourceProvider || prov?.source;
    return prov && src ? resolveProviderFieldWeight(src, fieldKey) * (typeof prov.confidence === 'number' ? prov.confidence : 0.9) : 0;
  };

  const getIncomingProvAuthority = (fieldKey: string): number => {
    const prov = findProv(incomingProvMap, fieldKey);
    const src = prov?.sourceProvider || prov?.source || resolvedSource;
    return resolveProviderFieldWeight(src, fieldKey) * (prov && typeof prov.confidence === 'number' ? prov.confidence : 0.95);
  };

  const applyField = (fieldName: string, value: unknown) => {
    const coupled = ItemProvenancePolicy.getCoupledFieldAliases(fieldName);
    if (lockedSet.has(fieldName) || coupled.some((alias) => lockedSet.has(alias))) return;
    if (allowedFieldSet && !allowedFieldSet.has(fieldName)) return;
    if (!allowedFieldSet) {
      const existingVal = getExistingValue(fieldName);
      if (existingVal !== undefined) {
        if (
          (fieldName === 'publicationTitle' || fieldName === 'journal' || fieldName === 'venue') &&
          typeof existingVal === 'string' && !/^arxiv(\s+e-?prints)?$/i.test(existingVal.trim()) &&
          typeof value === 'string' && /^arxiv(\s+e-?prints)?$/i.test(value.trim())
        ) return;
        const existingAuth = getExistingProvAuthority(fieldName);
        if (existingAuth > 0 && getIncomingProvAuthority(fieldName) + 0.05 < existingAuth) return;
      }
    }
    if (value !== undefined && value !== null && value !== '') {
      updateData[fieldName] = value;
      if (!updatedFields.includes(fieldName)) updatedFields.push(fieldName);
    }
  };

  if (m.title && !isPlaceholderItemTitle(String(m.title)) && m.title !== existingRec.title) applyField('title', m.title);

  const primaryRole = getPrimaryCreatorRoleForType(effectiveItemType);
  let resolvedCreators: Array<{ orderIndex: number; creatorType: string; firstName: string; lastName: string; fullName: string; fieldMode?: number }> | undefined;

  if (Array.isArray(m.creators) && m.creators.length > 0) {
    resolvedCreators = (m.creators as Array<CreatorLike>).map((c, index) => ({
      orderIndex: index, creatorType: resolveCanonicalCreatorRole(c.creatorType, { itemType: effectiveItemType }),
      firstName: c.firstName || '', lastName: c.lastName || '',
      fullName: c.fullName || c.name || [c.firstName, c.lastName].filter(Boolean).join(' '),
      ...(c.fieldMode !== undefined ? { fieldMode: c.fieldMode } : {}),
    }));
  } else if (Array.isArray(m.authors) && m.authors.length > 0) {
    resolvedCreators = (m.authors as string[]).map((authorStr: string, index: number) => {
      const parsed = parseCreatorString(authorStr, index, primaryRole);
      return {
        orderIndex: index, creatorType: primaryRole, firstName: parsed.firstName || '', lastName: parsed.lastName || '',
        fullName: parsed.fullName || authorStr, ...(parsed.fieldMode !== undefined ? { fieldMode: parsed.fieldMode } : {}),
      };
    });
  }

  if (resolvedCreators && resolvedCreators.length > 0) {
    const existingCreatorList = [...(Array.isArray(existingRec.creators) ? existingRec.creators : []), ...(Array.isArray(existingRec.contributors) ? existingRec.contributors : [])];
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
  if (Array.isArray(resolvedTags) && resolvedTags.length > 0 && (!Array.isArray(existingTags) || existingTags.length === 0)) applyField('tags', resolvedTags);

  const handledKeys = new Set([
    'title', 'creators', 'authors', 'editors', 'contributors', 'publicationDate', 'date', 'year',
    'publicationTitle', 'journal', 'abstract', 'abstractNote', 'tags', 'keywords', 'labels',
    'itemTags', 'zoteroTags', 'extraFields', 'notes', 'provenance',
  ]);

  for (const [key, val] of Object.entries(m)) {
    if (handledKeys.has(key) || TELEMETRY_ONLY_EXTRA_KEYS.has(key)) continue;
    if (val === undefined || val === null || val === '' || (Array.isArray(val) && val.length === 0)) continue;
    if (key === 'extra' && typeof val === 'string') {
      const existingExtraText = resolveExistingExtraText(existingRec, existingExtraObj, existingMetaObj);
      if (existingExtraText.length > 0) {
        applyField('extra', mergeZoteroExtraTextWithStatus(existingExtraText, val).merged);
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
      if (lockedSet.has(efKey) || efKey === 'lockedFields') continue;
      if (efVal !== undefined && efVal !== null && efVal !== '') {
        mergedExtraFields[efKey] = efVal;
        extraModified = true;
        if (!TELEMETRY_ONLY_EXTRA_KEYS.has(efKey)) applyField(efKey, efVal);
      }
    }
  }

  if (updatedFields.length > 0) {
    const nextProvMap: Record<string, FieldProvenanceRecord> = { ...existingProvMap, ...incomingProvMap };
    for (const fKey of updatedFields) {
      if (lockedSet.has(fKey) || TELEMETRY_ONLY_EXTRA_KEYS.has(fKey)) continue;
      if (!incomingProvMap[fKey]) {
        nextProvMap[fKey] = {
          source: resolvedSource, sourceProvider: resolvedSource, confidence: 0.95, verified: true,
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
  return ({ IDENTIFIER: 'doi', RECORD: 'bibtex', URL: 'url', FILE: 'pdf' } as const)[kind] ?? 'manual';
}
