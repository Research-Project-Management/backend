import { SCHEMA_V42_DATA } from './types.constants';

// The registry is the Library domain's source of truth for metadata. Keeping
// this derived prevents newly added type-specific fields from being accepted by
// the API but silently discarded by the persistence layer.
export const ITEM_COLUMN_METADATA_FIELDS = new Set([
  'title',
  'year',
  'doi',
  'DOI', // Zotero canonical casing
  'abstract',
  'abstractNote', // Zotero alias for abstract
  'itemType',
  'type',
  'publicationTitle',
  'journal', // alias for publicationTitle
  'publicationDate',
  'date', // Zotero alias for publicationDate
  'publisher',
  'place',
  'volume',
  'issue',
  'section',
  'partNumber',
  'partTitle',
  'pages',
  'series',
  'seriesTitle',
  'seriesText',
  'seriesNumber',
  'issn',
  'ISSN', // Zotero canonical casing
  'isbn',
  'ISBN', // Zotero canonical casing
  'pmid',
  'PMID', // Zotero canonical casing
  'pmcid',
  'PMCID', // Zotero canonical casing
  'url',
  'language',
  'journalAbbr',
  'journalAbbreviation', // Zotero alias for journalAbbr
  'shortTitle',
  'rights',
  'license',
  'citationKey',
  'citeKey',
  'libraryCatalog',
  'archive',
  'archiveLocation',
  'callNumber',
  'accessedAt',
  'accessDate', // alias for accessedAt
  'extra',
  // Dedicated Academic / Persistent Columns
  'arxivId',
  'archiveId', // Zotero alias for arxivId
  'archiveID', // Zotero v42 canonical casing
  'citationCount',
  'referenceCount',
  'openAccessPdfUrl',
]);

export {
  FIELD_ALIASES,
  REVERSE_FIELD_ALIASES,
} from './types.constants';

import {
  BASE_FIELD_MAPPINGS,
  REVERSE_BASE_FIELD_MAPPINGS,
} from './types.constants';

export { BASE_FIELD_MAPPINGS, REVERSE_BASE_FIELD_MAPPINGS };

export function resolveBaseColumnForField(
  itemType: string,
  fieldKey: string,
): string | undefined {
  return REVERSE_BASE_FIELD_MAPPINGS[itemType]?.[fieldKey];
}

export function resolveTypeSpecificFieldForBase(
  itemType: string,
  baseColumn: string,
): string | undefined {
  return BASE_FIELD_MAPPINGS[itemType]?.[baseColumn];
}

/**
 * Type-specific extra fields purely and deterministically derived from the official
 * Zotero Schema v42. Eliminates legacy hardcoding, guesswork, and technical debt.
 */
export const TYPE_SPECIFIC_EXTRA_FIELDS = [
  ...new Set(
    Object.values(SCHEMA_V42_DATA.itemTypes)
      .flatMap((itemType) => itemType.fields.map((field) => field.key))
      .filter((field) => !ITEM_COLUMN_METADATA_FIELDS.has(field)),
  ),
];

export function parseAccessDate(value?: string): Date | undefined {
  if (!value?.trim()) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export type { CreateItemData, UpdateItemData } from '../types/items.types';
