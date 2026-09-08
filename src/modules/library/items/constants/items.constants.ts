import { SCHEMA_V42_DATA } from '../../types/constants/types.constants';

// The registry is the Library domain's source of truth for metadata. Keeping
// this derived prevents newly added type-specific fields from being accepted by
// the API but silently discarded by the persistence layer.
export const CATALOG_COLUMN_METADATA_FIELDS = new Set([
  'title',
  'doi',
  'publicationTitle',
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
  'issn',
  'isbn',
  'pmid',
  'pmcid',
  'url',
  'type',
  'language',
  'journalAbbr',
  'shortTitle',
  'rights',
  'license',
  'citationKey',
  'libraryCatalog',
  'archive',
  'archiveLocation',
  'callNumber',
]);

export const LEGACY_TYPE_SPECIFIC_EXTRA_FIELDS = [
  'seriesNumber',
  'abstractNote',
  'edition',
  'numPages',
  'numberOfVolumes',
  'bookTitle',
  'proceedingsTitle',
  'conferenceName',
  'eventPlace',
  'websiteTitle',
  'websiteType',
  'university',
  'institution',
  'country',
  'assignee',
  'issuingAuthority',
  'patentNumber',
  'applicationNumber',
  'reportNumber',
  'reportType',
  'thesisType',
  'genre',
  'filingDate',
  'legalStatus',
  'versionNumber',
  'blogTitle',
  'forumTitle',
  'postType',
  'presentationType',
  'meetingName',
  'letterType',
  'manuscriptType',
  'mapType',
  'artworkMedium',
  'artworkSize',
  'distributor',
  'runningTime',
  'programTitle',
  'episodeNumber',
  'podcastType',
  'interviewMedium',
  'dictionaryTitle',
  'encyclopediaTitle',
  'originalDate',
  'originalPublisher',
  'originalPlace',
  'court',
  'docketNumber',
  'firstPage',
  'dateDecided',
  'reporter',
  'reporterVolume',
  'codeNumber',
  'publicLawNumber',
  'dateEnacted',
  'billNumber',
  'legislativeBody',
  'programmingLanguage',
  'standardNumber',
] as const;

export const ACADEMIC_METRICS_EXTRA_FIELDS = [
  'citationCount',
  'referenceCount',
  'openAccessPdfUrl',
  'storageId',
  'explicitCitationKey',
] as const;

export const TYPE_SPECIFIC_EXTRA_FIELDS = [
  ...new Set([
    ...LEGACY_TYPE_SPECIFIC_EXTRA_FIELDS,
    ...ACADEMIC_METRICS_EXTRA_FIELDS,
    ...Object.values(SCHEMA_V42_DATA.itemTypes)
      .flatMap((itemType) => itemType.fields.map((field) => field.key))
      .filter((field) => !CATALOG_COLUMN_METADATA_FIELDS.has(field)),
  ]),
];

export function parseAccessDate(value?: string): Date | undefined {
  if (!value?.trim()) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export type {
  CreateCatalogItemData,
  UpdateCatalogItemData,
} from '../types/items.types';


