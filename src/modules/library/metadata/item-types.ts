export type LibraryCreatorType =
  | 'artist'
  | 'attorneyAgent'
  | 'author'
  | 'bookAuthor'
  | 'cartographer'
  | 'castMember'
  | 'chair'
  | 'commenter'
  | 'composer'
  | 'contributor'
  | 'cosponsor'
  | 'counsel'
  | 'director'
  | 'editor'
  | 'guest'
  | 'interviewee'
  | 'interviewer'
  | 'inventor'
  | 'performer'
  | 'podcaster'
  | 'presenter'
  | 'producer'
  | 'programmer'
  | 'recipient'
  | 'reviewedAuthor'
  | 'scriptwriter'
  | 'seriesEditor'
  | 'sponsor'
  | 'translator'
  | 'wordsBy';

export interface LibraryCreatorInput {
  creatorType?: LibraryCreatorType | string | null;
  firstName?: string | null;
  lastName?: string | null;
  name?: string | null;
}

export interface NormalizedCreatorLists {
  authors: string[];
  editors: string[];
  otherCreators: LibraryCreatorInput[];
}

export interface LibraryItemTypeDefinition {
  itemType: SupportedLibraryItemType;
  localized: string;
  selectable: boolean;
  system: boolean;
}

export interface LibraryItemFieldDefinition {
  key: string;
  label: string;
  baseField?: string;
  source: 'column' | 'extra';
}

export interface LibraryCreatorTypeDefinition {
  creatorType: LibraryCreatorType | string;
  localized: string;
  primary?: boolean;
}

export interface LibraryItemTypeSchema {
  itemType: SupportedLibraryItemType;
  localized: string;
  selectable: boolean;
  fields: LibraryItemFieldDefinition[];
  creatorTypes: LibraryCreatorTypeDefinition[];
}

export const SYSTEM_LIBRARY_ITEM_TYPES = [
  'annotation',
  'attachment',
  'note',
] as const;

export const SELECTABLE_LIBRARY_ITEM_TYPES = [
  'artwork',
  'audioRecording',
  'bill',
  'blogPost',
  'book',
  'bookSection',
  'case',
  'computerProgram',
  'conferencePaper',
  'dataset',
  'dictionaryEntry',
  'document',
  'email',
  'encyclopediaArticle',
  'film',
  'forumPost',
  'hearing',
  'instantMessage',
  'interview',
  'journalArticle',
  'letter',
  'magazineArticle',
  'manuscript',
  'map',
  'newspaperArticle',
  'patent',
  'podcast',
  'preprint',
  'presentation',
  'radioBroadcast',
  'report',
  'standard',
  'statute',
  'thesis',
  'tvBroadcast',
  'videoRecording',
  'webpage',
] as const;

export const SUPPORTED_LIBRARY_ITEM_TYPES = [
  ...SYSTEM_LIBRARY_ITEM_TYPES,
  ...SELECTABLE_LIBRARY_ITEM_TYPES,
] as const;

export type SelectableLibraryItemType =
  (typeof SELECTABLE_LIBRARY_ITEM_TYPES)[number];
export type SystemLibraryItemType = (typeof SYSTEM_LIBRARY_ITEM_TYPES)[number];
export type SupportedLibraryItemType =
  (typeof SUPPORTED_LIBRARY_ITEM_TYPES)[number];

export const ZOTERO_SCHEMA_VERSION = 42;

export const ITEM_TYPE_LABELS: Record<SupportedLibraryItemType, string> = {
  annotation: 'Annotation',
  artwork: 'Artwork',
  attachment: 'Attachment',
  audioRecording: 'Audio Recording',
  bill: 'Bill',
  blogPost: 'Blog Post',
  book: 'Book',
  bookSection: 'Book Section',
  case: 'Case',
  computerProgram: 'Software',
  conferencePaper: 'Conference Paper',
  dataset: 'Dataset',
  dictionaryEntry: 'Dictionary Entry',
  document: 'Document',
  email: 'E-mail',
  encyclopediaArticle: 'Encyclopedia Article',
  film: 'Film',
  forumPost: 'Forum Post',
  hearing: 'Hearing',
  instantMessage: 'Instant Message',
  interview: 'Interview',
  journalArticle: 'Journal Article',
  letter: 'Letter',
  magazineArticle: 'Magazine Article',
  manuscript: 'Manuscript',
  map: 'Map',
  newspaperArticle: 'Newspaper Article',
  note: 'Note',
  patent: 'Patent',
  podcast: 'Podcast',
  preprint: 'Preprint',
  presentation: 'Presentation',
  radioBroadcast: 'Radio Broadcast',
  report: 'Report',
  standard: 'Standard',
  statute: 'Statute',
  thesis: 'Thesis',
  tvBroadcast: 'TV Broadcast',
  videoRecording: 'Video Recording',
  webpage: 'Web Page',
};

export const ITEM_TYPE_ALIASES: Record<string, SupportedLibraryItemType> = {
  article: 'journalArticle',
  computerprogram: 'computerProgram',
  'computer program': 'computerProgram',
  email: 'email',
  'e-mail': 'email',
  journalarticle: 'journalArticle',
  'journal article': 'journalArticle',
  paper: 'journalArticle',
  software: 'computerProgram',
  webpage: 'webpage',
  'web page': 'webpage',
};

export const FIELD_LABELS: Record<string, string> = {
  abstractNote: 'Abstract',
  accessDate: 'Accessed',
  archive: 'Archive',
  archiveID: 'Archive ID',
  archiveLocation: 'Loc. in Archive',
  artworkMedium: 'Medium',
  artworkSize: 'Artwork Size',
  audioRecordingFormat: 'Format',
  billNumber: 'Bill Number',
  blogTitle: 'Blog Title',
  bookTitle: 'Book Title',
  callNumber: 'Call Number',
  caseName: 'Case Name',
  citationKey: 'Citation Key',
  code: 'Code',
  codePages: 'Code Pages',
  codeVolume: 'Code Volume',
  committee: 'Committee',
  company: 'Company',
  conferenceName: 'Conference Name',
  country: 'Country',
  court: 'Court',
  date: 'Date',
  dateDecided: 'Date Decided',
  dateEnacted: 'Date Enacted',
  dictionaryTitle: 'Dictionary Title',
  distributor: 'Distributor',
  docketNumber: 'Docket Number',
  DOI: 'DOI',
  edition: 'Edition',
  encyclopediaTitle: 'Encyclopedia Title',
  episodeNumber: 'Episode Number',
  eventPlace: 'Event Place',
  extra: 'Extra',
  filingDate: 'Filing Date',
  firstPage: 'First Page',
  format: 'Format',
  genre: 'Genre',
  history: 'History',
  ISBN: 'ISBN',
  ISSN: 'ISSN',
  issue: 'Issue',
  issueDate: 'Issue Date',
  issuingAuthority: 'Issuing Authority',
  journalAbbreviation: 'Journal Abbr',
  language: 'Language',
  legalStatus: 'Legal Status',
  legislativeBody: 'Legislative Body',
  libraryCatalog: 'Library Catalog',
  manuscriptType: 'Type',
  mapType: 'Type',
  medium: 'Medium',
  meetingName: 'Meeting Name',
  nameOfAct: 'Name of Act',
  network: 'Network',
  number: 'Number',
  numberOfVolumes: 'Number of Volumes',
  numPages: 'Number of Pages',
  pages: 'Pages',
  patentNumber: 'Patent Number',
  place: 'Place',
  postType: 'Post Type',
  presentationType: 'Type',
  priorityNumbers: 'Priority Numbers',
  proceedingsTitle: 'Proceedings Title',
  programTitle: 'Program Title',
  programmingLanguage: 'Programming Language',
  publicationTitle: 'Publication',
  publisher: 'Publisher',
  references: 'References',
  reporter: 'Reporter',
  reporterVolume: 'Reporter Volume',
  repository: 'Repository',
  repositoryLocation: 'Repository Location',
  rights: 'Rights',
  runningTime: 'Running Time',
  scale: 'Scale',
  section: 'Section',
  series: 'Series',
  seriesNumber: 'Series Number',
  seriesText: 'Series Text',
  seriesTitle: 'Series Title',
  session: 'Session',
  shortTitle: 'Short Title',
  studio: 'Studio',
  system: 'System',
  thesisType: 'Type',
  title: 'Title',
  type: 'Type',
  university: 'University',
  url: 'URL',
  versionNumber: 'Version',
  videoRecordingFormat: 'Format',
  volume: 'Volume',
  websiteTitle: 'Website Title',
  websiteType: 'Website Type',
};

export const CREATOR_TYPE_LABELS: Record<string, string> = {
  artist: 'Artist',
  attorneyAgent: 'Attorney/Agent',
  author: 'Author',
  bookAuthor: 'Book Author',
  cartographer: 'Cartographer',
  castMember: 'Cast Member',
  chair: 'Chair',
  commenter: 'Commenter',
  composer: 'Composer',
  contributor: 'Contributor',
  cosponsor: 'Cosponsor',
  counsel: 'Counsel',
  director: 'Director',
  editor: 'Editor',
  guest: 'Guest',
  interviewee: 'Interview With',
  interviewer: 'Interviewer',
  inventor: 'Inventor',
  performer: 'Performer',
  podcaster: 'Podcaster',
  presenter: 'Presenter',
  producer: 'Producer',
  programmer: 'Programmer',
  recipient: 'Recipient',
  reviewedAuthor: 'Reviewed Author',
  scriptwriter: 'Scriptwriter',
  seriesEditor: 'Series Editor',
  sponsor: 'Sponsor',
  translator: 'Translator',
  wordsBy: 'Words By',
};

export const COMMON_TAIL_FIELDS = [
  'DOI',
  'citationKey',
  'url',
  'accessDate',
  'archive',
  'archiveLocation',
  'shortTitle',
  'language',
  'libraryCatalog',
  'callNumber',
  'rights',
  'extra',
] as const;

export const ITEM_TYPE_FIELD_KEYS: Partial<
  Record<SupportedLibraryItemType, string[]>
> = {
  journalArticle: [
    'title',
    'abstractNote',
    'publicationTitle',
    'publisher',
    'place',
    'date',
    'volume',
    'issue',
    'section',
    'pages',
    'series',
    'seriesTitle',
    'journalAbbreviation',
    ...COMMON_TAIL_FIELDS,
    'ISSN',
  ],
  preprint: [
    'title',
    'abstractNote',
    'repository',
    'archiveID',
    'date',
    'series',
    'seriesNumber',
    ...COMMON_TAIL_FIELDS,
  ],
  conferencePaper: [
    'title',
    'abstractNote',
    'proceedingsTitle',
    'conferenceName',
    'publisher',
    'place',
    'date',
    'eventPlace',
    'volume',
    'issue',
    'numberOfVolumes',
    'pages',
    'series',
    'seriesNumber',
    ...COMMON_TAIL_FIELDS,
    'ISBN',
    'ISSN',
  ],
  thesis: [
    'title',
    'abstractNote',
    'thesisType',
    'university',
    'place',
    'date',
    'series',
    'seriesNumber',
    'numPages',
    ...COMMON_TAIL_FIELDS,
    'ISBN',
    'ISSN',
  ],
  report: [
    'title',
    'abstractNote',
    'reportNumber',
    'reportType',
    'institution',
    'place',
    'date',
    'seriesTitle',
    'pages',
    ...COMMON_TAIL_FIELDS,
  ],
  book: [
    'title',
    'abstractNote',
    'series',
    'seriesNumber',
    'volume',
    'numberOfVolumes',
    'edition',
    'date',
    'publisher',
    'place',
    'numPages',
    ...COMMON_TAIL_FIELDS,
    'ISBN',
    'ISSN',
  ],
  bookSection: [
    'title',
    'abstractNote',
    'bookTitle',
    'series',
    'seriesNumber',
    'volume',
    'numberOfVolumes',
    'edition',
    'date',
    'publisher',
    'place',
    'pages',
    ...COMMON_TAIL_FIELDS,
    'ISBN',
    'ISSN',
  ],
  dataset: [
    'title',
    'abstractNote',
    'identifier',
    'type',
    'versionNumber',
    'date',
    'repository',
    'repositoryLocation',
    'format',
    ...COMMON_TAIL_FIELDS,
  ],
  computerProgram: [
    'title',
    'abstractNote',
    'seriesTitle',
    'versionNumber',
    'date',
    'system',
    'company',
    'place',
    'programmingLanguage',
    'rights',
    'citationKey',
    'url',
    'accessDate',
    'DOI',
    'ISBN',
    'archive',
    'archiveLocation',
    'libraryCatalog',
    'callNumber',
    'shortTitle',
    'extra',
  ],
  patent: [
    'title',
    'abstractNote',
    'place',
    'country',
    'patentNumber',
    'issueDate',
    'filingDate',
    'issuingAuthority',
    'pages',
    'applicationNumber',
    'priorityNumbers',
    'legalStatus',
    ...COMMON_TAIL_FIELDS,
  ],
  standard: [
    'title',
    'abstractNote',
    'type',
    'number',
    'versionNumber',
    'date',
    'publisher',
    'place',
    ...COMMON_TAIL_FIELDS,
  ],
  webpage: [
    'title',
    'abstractNote',
    'websiteTitle',
    'websiteType',
    'date',
    'url',
    'accessDate',
    'shortTitle',
    'language',
    'rights',
    'extra',
  ],
  document: [
    'title',
    'abstractNote',
    'publisher',
    'date',
    'language',
    'url',
    'accessDate',
    'archive',
    'archiveLocation',
    'libraryCatalog',
    'callNumber',
    'rights',
    'extra',
  ],
};

export const ITEM_TYPE_CREATOR_KEYS: Partial<
  Record<SupportedLibraryItemType, Array<{ creatorType: string; primary?: boolean }>>
> = {
  artwork: [{ creatorType: 'artist', primary: true }, { creatorType: 'contributor' }],
  audioRecording: [
    { creatorType: 'performer', primary: true },
    { creatorType: 'composer' },
    { creatorType: 'wordsBy' },
    { creatorType: 'translator' },
    { creatorType: 'contributor' },
  ],
  book: [
    { creatorType: 'author', primary: true },
    { creatorType: 'contributor' },
    { creatorType: 'editor' },
    { creatorType: 'translator' },
    { creatorType: 'seriesEditor' },
  ],
  bookSection: [
    { creatorType: 'author', primary: true },
    { creatorType: 'contributor' },
    { creatorType: 'editor' },
    { creatorType: 'bookAuthor' },
    { creatorType: 'translator' },
    { creatorType: 'seriesEditor' },
  ],
  computerProgram: [
    { creatorType: 'programmer', primary: true },
    { creatorType: 'contributor' },
  ],
  conferencePaper: [
    { creatorType: 'author', primary: true },
    { creatorType: 'contributor' },
    { creatorType: 'editor' },
    { creatorType: 'translator' },
    { creatorType: 'seriesEditor' },
  ],
  dataset: [{ creatorType: 'author', primary: true }, { creatorType: 'contributor' }],
  interview: [
    { creatorType: 'interviewee', primary: true },
    { creatorType: 'interviewer' },
  ],
  journalArticle: [
    { creatorType: 'author', primary: true },
    { creatorType: 'contributor' },
    { creatorType: 'reviewedAuthor' },
  ],
  patent: [
    { creatorType: 'inventor', primary: true },
    { creatorType: 'attorneyAgent' },
    { creatorType: 'contributor' },
  ],
  preprint: [{ creatorType: 'author', primary: true }, { creatorType: 'contributor' }],
  presentation: [
    { creatorType: 'presenter', primary: true },
    { creatorType: 'contributor' },
  ],
  report: [
    { creatorType: 'author', primary: true },
    { creatorType: 'contributor' },
  ],
  thesis: [
    { creatorType: 'author', primary: true },
    { creatorType: 'contributor' },
  ],
  webpage: [
    { creatorType: 'author', primary: true },
    { creatorType: 'contributor' },
  ],
};

const SUPPORTED_TYPE_SET = new Set<string>(SUPPORTED_LIBRARY_ITEM_TYPES);

export function normalizeLibraryItemType(
  itemType?: string | null,
): SupportedLibraryItemType {
  const raw = itemType?.trim();
  if (!raw) return 'journalArticle';

  if (SUPPORTED_TYPE_SET.has(raw)) {
    return raw as SupportedLibraryItemType;
  }

  return ITEM_TYPE_ALIASES[raw.toLowerCase()] ?? 'journalArticle';
}

export function normalizeTags(
  values: Array<string | null | undefined> = [],
): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const tag = value?.trim();
    if (tag) seen.add(tag);
  }
  return Array.from(seen);
}

export function normalizeCreators(
  creators?: LibraryCreatorInput[] | null,
): NormalizedCreatorLists {
  const authors: string[] = [];
  const editors: string[] = [];
  const otherCreators: LibraryCreatorInput[] = [];

  for (const creator of creators ?? []) {
    const name = formatCreatorName(creator);
    if (!name) continue;

    switch (creator.creatorType) {
      case 'author':
      case 'bookAuthor':
        authors.push(name);
        break;
      case 'editor':
      case 'seriesEditor':
        editors.push(name);
        break;
      default:
        otherCreators.push(creator);
        break;
    }
  }

  return { authors, editors, otherCreators };
}

export function formatCreatorName(creator?: LibraryCreatorInput | null): string {
  if (!creator) return '';
  const singleFieldName = creator.name?.trim();
  if (singleFieldName) return singleFieldName;

  const firstName = creator.firstName?.trim();
  const lastName = creator.lastName?.trim();
  return [firstName, lastName].filter(Boolean).join(' ');
}

export function extractYearFromDate(value?: string | null): number | null {
  const match = value?.match(/\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/);
  return match ? Number(match[1]) : null;
}
