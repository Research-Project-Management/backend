/**
 * Official Zotero Bibliographic Item-Type Definitions — Schema v42
 * Canonical Ground Truth for the Flux Library Domain, dynamically loaded from official
 * api.zotero.org/schema specifications. Eliminates manual maintenance and guesswork.
 */
import {
  SchemaRegistrySnapshot,
  ItemTypeDefinition,
  ItemFieldDefinition,
  CreatorTypeDefinition,
} from '../types/types.types';
import rawZoteroSchema from '../data/zotero-schema.json';

export const LIBRARY_SCHEMA_VERSION = rawZoteroSchema.version || 42;
export const SCHEMA_SOURCE = `zotero-schema-v${LIBRARY_SCHEMA_VERSION}`;

const CATEGORY_MAP: Record<string, ItemTypeDefinition['category']> = {
  journalArticle: 'academic',
  preprint: 'academic',
  conferencePaper: 'academic',
  thesis: 'academic',
  report: 'academic',
  dataset: 'academic',
  presentation: 'academic',
  standard: 'academic',
  book: 'books',
  bookSection: 'books',
  manuscript: 'books',
  dictionaryEntry: 'books',
  encyclopediaArticle: 'books',
  magazineArticle: 'articles',
  newspaperArticle: 'articles',
  bill: 'legal',
  case: 'legal',
  hearing: 'legal',
  statute: 'legal',
  patent: 'legal',
  audioRecording: 'media',
  videoRecording: 'media',
  film: 'media',
  radioBroadcast: 'media',
  tvBroadcast: 'media',
  podcast: 'media',
  artwork: 'media',
  map: 'media',
  blogPost: 'documents',
  webpage: 'documents',
  forumPost: 'documents',
  letter: 'documents',
  interview: 'documents',
  document: 'documents',
  email: 'documents',
  instantMessage: 'documents',
  computerProgram: 'documents',
  annotation: 'special',
  attachment: 'special',
  note: 'special',
};

const FIELD_CATEGORY_MAP: Record<
  string,
  NonNullable<ItemFieldDefinition['category']>
> = {
  title: 'core',
  shortTitle: 'core',
  abstractNote: 'core',
  publicationTitle: 'venue',
  publisher: 'venue',
  place: 'venue',
  university: 'venue',
  institution: 'venue',
  conferenceName: 'venue',
  court: 'venue',
  distributor: 'venue',
  studio: 'venue',
  network: 'venue',
  company: 'venue',
  repository: 'venue',
  date: 'publication',
  dateDecided: 'publication',
  dateEnacted: 'publication',
  issueDate: 'publication',
  filingDate: 'publication',
  accessDate: 'publication',
  pages: 'publication',
  volume: 'publication',
  issue: 'publication',
  section: 'publication',
  partNumber: 'publication',
  partTitle: 'publication',
  series: 'publication',
  seriesTitle: 'publication',
  seriesText: 'publication',
  seriesNumber: 'publication',
  journalAbbreviation: 'publication',
  language: 'publication',
  edition: 'publication',
  numPages: 'publication',
  numberOfVolumes: 'publication',
  runningTime: 'publication',
  versionNumber: 'publication',
  DOI: 'identifiers',
  ISSN: 'identifiers',
  ISBN: 'identifiers',
  PMID: 'identifiers',
  PMCID: 'identifiers',
  url: 'identifiers',
  citationKey: 'identifiers',
  archiveID: 'identifiers',
  patentNumber: 'identifiers',
  applicationNumber: 'identifiers',
  reportNumber: 'identifiers',
  docketNumber: 'identifiers',
  documentNumber: 'identifiers',
  billNumber: 'identifiers',
  standardNumber: 'identifiers',
  codeNumber: 'identifiers',
  publicLawNumber: 'identifiers',
  archive: 'archive',
  archiveLocation: 'archive',
  libraryCatalog: 'archive',
  callNumber: 'archive',
  citationCount: 'identifiers',
  rights: 'extra',
  extra: 'extra',
};

const MONO_FIELDS = new Set([
  'volume',
  'issue',
  'pages',
  'seriesNumber',
  'date',
  'filingDate',
  'accessDate',
  'dateDecided',
  'dateEnacted',
  'issueDate',
  'DOI',
  'ISBN',
  'ISSN',
  'PMID',
  'PMCID',
  'archiveID',
  'patentNumber',
  'applicationNumber',
  'reportNumber',
  'docketNumber',
  'documentNumber',
  'billNumber',
  'standardNumber',
  'codeNumber',
  'publicLawNumber',
  'citationKey',
  'url',
  'callNumber',
  'versionNumber',
  'episodeNumber',
  'runningTime',
  'scale',
  'numPages',
  'numberOfVolumes',
  'citationCount',
  'doi',
  'isbn',
  'issn',
  'pmid',
  'pmcid',
]);

export const BASE_SEMANTICS = [
  'title',
  'publicationTitle',
  'publisher',
  'place',
  'date',
  'volume',
  'pages',
  'type',
  'number',
  'medium',
  'originalDate',
  'status',
  'authority',
] as const;

function buildCanonicalSnapshot(): SchemaRegistrySnapshot {
  const schema = rawZoteroSchema as any;
  const en = schema.locales?.['en-US'] || {
    fields: {},
    itemTypes: {},
    creatorTypes: {},
  };
  const baseFieldMappings: Record<string, Record<string, string>> = {};
  const reverseBaseFieldMappings: Record<string, Record<string, string>> = {};
  const itemTypes: Record<string, ItemTypeDefinition> = {};
  const distinctKeys = new Set<string>();

  for (const t of schema.itemTypes || []) {
    const typeKey = t.itemType;
    baseFieldMappings[typeKey] = {};
    reverseBaseFieldMappings[typeKey] = {};

    const fields: ItemFieldDefinition[] = (t.fields || []).map(
      (f: any, idx: number) => {
        distinctKeys.add(f.field);
        if (f.baseField) {
          baseFieldMappings[typeKey][f.baseField] = f.field;
          reverseBaseFieldMappings[typeKey][f.field] = f.baseField;
        }
        return {
          key: f.field,
          label: en.fields[f.field] || f.field,
          order: idx + 1,
          baseField: f.baseField,
          category: FIELD_CATEGORY_MAP[f.field] || 'publication',
          type:
            schema.meta?.fields?.[f.field]?.type === 'date'
              ? 'date'
              : f.field === 'url'
                ? 'url'
                : f.field === 'abstractNote' || f.field === 'extra'
                  ? 'textarea'
                  : 'text',
          mono: MONO_FIELDS.has(f.field),
        };
      },
    );

    const creatorTypes: CreatorTypeDefinition[] = (t.creatorTypes || []).map(
      (c: any) => ({
        creatorType: c.creatorType,
        label: en.creatorTypes[c.creatorType] || c.creatorType,
        primary: Boolean(c.primary),
      }),
    );

    const primaryCreator =
      creatorTypes.find((c) => c.primary)?.creatorType ||
      creatorTypes[0]?.creatorType ||
      'author';
    const isSpecial = ['attachment', 'note', 'annotation'].includes(typeKey);

    itemTypes[typeKey] = {
      itemType: typeKey,
      label: en.itemTypes[typeKey] || typeKey,
      category: CATEGORY_MAP[typeKey] || 'documents',
      fields,
      creatorTypes,
      primaryCreatorType: primaryCreator,
      isBibliographic: !isSpecial,
      isSpecial,
      source: `zotero-schema-v${LIBRARY_SCHEMA_VERSION}`,
      schemaVersion: LIBRARY_SCHEMA_VERSION,
    };
  }

  return {
    version: LIBRARY_SCHEMA_VERSION,
    source: `zotero-schema-v${LIBRARY_SCHEMA_VERSION}`,
    distinctFieldKeys: Array.from(distinctKeys),
    creatorRoles: en.creatorTypes || {},
    baseFieldMappings,
    reverseBaseFieldMappings,
    itemTypes,
  };
}

export const SCHEMA_V42_DATA: SchemaRegistrySnapshot = buildCanonicalSnapshot();
export const ALL_CREATOR_ROLES: Record<string, string> =
  SCHEMA_V42_DATA.creatorRoles;
export const BASE_FIELD_MAPPINGS = SCHEMA_V42_DATA.baseFieldMappings;
export const REVERSE_BASE_FIELD_MAPPINGS =
  SCHEMA_V42_DATA.reverseBaseFieldMappings;
