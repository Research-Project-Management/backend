import {
  SCHEMA_V42_DATA,
  BASE_FIELD_MAPPINGS,
  REVERSE_BASE_FIELD_MAPPINGS,
} from '../../shared-kernel/types/schema.constants';

export const ITEM_COLUMN_METADATA_FIELDS = new Set([
  'title',
  'year',
  'doi',
  'DOI',
  'abstract',
  'abstractNote',
  'itemType',
  'type',
  'publicationTitle',
  'journal',
  'publicationDate',
  'date',
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
  'ISSN',
  'isbn',
  'ISBN',
  'pmid',
  'PMID',
  'pmcid',
  'PMCID',
  'url',
  'language',
  'journalAbbr',
  'journalAbbreviation',
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
  'accessDate',
  'extra',
  'arxivId',
  'archiveId',
  'archiveID',
  'citationCount',
  'referenceCount',
  'openAccessPdfUrl',
]);

export {
  FIELD_ALIASES,
  REVERSE_FIELD_ALIASES,
  BASE_FIELD_MAPPINGS,
  REVERSE_BASE_FIELD_MAPPINGS,
} from '../../shared-kernel/types/schema.constants';

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

export type { CreateItemData, UpdateItemData } from './items.types';
