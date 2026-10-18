import {
  SCHEMA_V42_DATA,
  ITEM_COLUMN_METADATA_FIELDS,
  FIELD_ALIASES,
  harmonizeZoteroFields,
  LibraryItemSource,
} from '@/modules/library/core';

export const SYSTEM_RESERVED_KEYS = new Set([
  'id',
  'userId',
  'projectId',
  'deletedAt',
  'createdAt',
  'updatedAt',
  'version',
  'citationCount',
  'referenceCount',
  'crossrefEnriched',
  'retractionStatus',
  'isRetracted',
]);

export const NON_SCALAR_ENRICH_KEYS = new Set([
  ...SYSTEM_RESERVED_KEYS,
  'title',
  'authors',
  'editors',
  'creators',
  'contributors',
  'keywords',
  'labels',
  'tags',
  'notes',
  'extraFields',
]);

export const SCALAR_METADATA_FIELDS: string[] = Array.from(
  new Set([
    ...SCHEMA_V42_DATA.distinctFieldKeys,
    ...ITEM_COLUMN_METADATA_FIELDS,
    ...Object.keys(FIELD_ALIASES),
    ...Object.values(FIELD_ALIASES),
  ]),
).filter((key) => !NON_SCALAR_ENRICH_KEYS.has(key));

export function sanitizeOverrides(
  overrides?: Record<string, unknown>,
): Record<string, unknown> {
  if (!overrides || typeof overrides !== 'object') return {};
  const clean: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(overrides)) {
    if (!SYSTEM_RESERVED_KEYS.has(key)) {
      clean[key] = val;
    }
  }
  return clean;
}

export function buildEnrichmentPatch(
  existingRec: Record<string, unknown> | null | undefined,
  rawProposed: Record<string, unknown>,
): Record<string, unknown> {
  const resolvedType =
    (typeof rawProposed.itemType === 'string' && rawProposed.itemType) ||
    (typeof existingRec?.itemType === 'string' && existingRec.itemType) ||
    'journalArticle';
  const p = harmonizeZoteroFields(rawProposed, {
    itemType: resolvedType,
    syncExtraFields: true,
  });
  const enrichPatch: Record<string, unknown> = {};

  const maybeEnrich = (field: string, val: unknown) => {
    if (val == null || val === '') return;
    const current = existingRec?.[field];
    if (
      current == null ||
      current === '' ||
      (Array.isArray(current) && current.length === 0)
    ) {
      enrichPatch[field] = val;
    }
  };

  if (p.title && p.title !== 'Untitled Document') {
    const rawCurrentTitle = existingRec?.title;
    const currentTitle = (
      typeof rawCurrentTitle === 'string' || typeof rawCurrentTitle === 'number'
        ? String(rawCurrentTitle)
        : ''
    ).trim();
    if (
      !currentTitle ||
      currentTitle === 'Untitled Document' ||
      currentTitle === 'Uploaded Document' ||
      /\.pdf$/i.test(currentTitle) ||
      /^10\.\d{4,9}\//.test(currentTitle)
    ) {
      enrichPatch['title'] = p.title;
    }
  }

  for (const field of SCALAR_METADATA_FIELDS) {
    maybeEnrich(field, p[field]);
  }

  const pExtra =
    p.extraFields &&
    typeof p.extraFields === 'object' &&
    !Array.isArray(p.extraFields)
      ? (p.extraFields as Record<string, unknown>)
      : undefined;
  if (pExtra) {
    const existingExtra =
      existingRec?.extraFields &&
      typeof existingRec.extraFields === 'object' &&
      !Array.isArray(existingRec.extraFields)
        ? (existingRec.extraFields as Record<string, unknown>)
        : {};
    const mergedExtra: Record<string, unknown> = { ...existingExtra };
    let extraChanged = false;
    for (const [efKey, efVal] of Object.entries(pExtra)) {
      if (efVal == null || efVal === '') continue;
      if (mergedExtra[efKey] == null || mergedExtra[efKey] === '') {
        mergedExtra[efKey] = efVal;
        extraChanged = true;
      }
      maybeEnrich(efKey, efVal);
    }
    if (extraChanged) {
      enrichPatch['extraFields'] = mergedExtra;
    }
  }

  const existingAuthors = existingRec?.authors as unknown[] | undefined;
  const existingEditors = existingRec?.editors as unknown[] | undefined;
  const existingCreators = existingRec?.creators as unknown[] | undefined;
  const existingKeywords = (existingRec?.keywords || existingRec?.labels) as
    unknown[] | undefined;

  const pAuthors = p.authors as unknown[] | undefined;
  const pEditors = p.editors as unknown[] | undefined;
  const pCreators = p.creators as unknown[] | undefined;
  const pKeywords = p.keywords as unknown[] | undefined;

  if (pAuthors?.length && !existingAuthors?.length) {
    enrichPatch['authors'] = pAuthors;
  }
  if (pEditors?.length && !existingEditors?.length) {
    enrichPatch['editors'] = pEditors;
  }
  if (pCreators?.length && !existingCreators?.length) {
    enrichPatch['creators'] = pCreators;
  }
  if (pKeywords?.length && !existingKeywords?.length) {
    enrichPatch['keywords'] = pKeywords;
    enrichPatch['labels'] = pKeywords;
  }

  return enrichPatch;
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
