import { SCHEMA_V42_DATA } from '../../types/constants/types.constants';

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

export const FIELD_ALIASES: Record<string, string> = {
  DOI: 'doi',
  ISBN: 'isbn',
  ISSN: 'issn',
  PMID: 'pmid',
  PMCID: 'pmcid',
  archiveID: 'arxivId',
  archiveId: 'arxivId',
  abstractNote: 'abstract',
  date: 'publicationDate',
  journal: 'publicationTitle',
  journalAbbreviation: 'journalAbbr',
  accessDate: 'accessedAt',
  license: 'rights',
  citeKey: 'citationKey',
};

export const REVERSE_FIELD_ALIASES: Record<string, string> = {
  doi: 'DOI',
  isbn: 'ISBN',
  issn: 'ISSN',
  pmid: 'PMID',
  pmcid: 'PMCID',
  arxivId: 'archiveId',
  abstract: 'abstractNote',
  publicationDate: 'date',
  publicationTitle: 'journal',
  journalAbbr: 'journalAbbreviation',
  accessedAt: 'accessDate',
  rights: 'license',
  citationKey: 'citationKey',
};

export {
  BASE_FIELD_MAPPINGS,
  REVERSE_BASE_FIELD_MAPPINGS,
} from '../../types/constants/types.constants';

export const LEGACY_TYPE_SPECIFIC_EXTRA_FIELDS = [
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
  'storageId',
  'explicitCitationKey',
] as const;

export const TYPE_SPECIFIC_EXTRA_FIELDS = [
  ...new Set([
    ...LEGACY_TYPE_SPECIFIC_EXTRA_FIELDS,
    ...ACADEMIC_METRICS_EXTRA_FIELDS,
    ...Object.values(SCHEMA_V42_DATA.itemTypes)
      .flatMap((itemType) => itemType.fields.map((field) => field.key))
      .filter((field) => !ITEM_COLUMN_METADATA_FIELDS.has(field)),
  ]),
];

export function parseAccessDate(value?: string): Date | undefined {
  if (!value?.trim()) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export type {
  CreateItemData,
  UpdateItemData,
} from '../types/items.types';
