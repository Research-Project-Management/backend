/**
 * Zotero Official Metadata Schema & Item Types Definition
 * Based on https://github.com/zotero/zotero-schema and https://api.zotero.org/schema
 */

export interface SchemaFieldDefinition {
  field: string;
  label: string;
  placeholder?: string;
  type: 'text' | 'textarea' | 'date' | 'number' | 'url';
  category?: 'core' | 'venue' | 'publication' | 'identifiers' | 'archive' | 'extra';
}

export interface SchemaCreatorTypeDefinition {
  creatorType: string;
  label: string;
  primary?: boolean;
}

export interface SchemaItemTypeDefinition {
  itemType: string;
  label: string;
  category: 'academic' | 'books' | 'articles' | 'legal' | 'media' | 'documents';
  primaryCreatorType: string;
  creatorTypes: SchemaCreatorTypeDefinition[];
  fields: SchemaFieldDefinition[];
}

// ── 1. Global Creator Roles ──────────────────────────────────────────────────
export const ALL_CREATOR_TYPES: Record<string, string> = {
  author: 'Author',
  editor: 'Editor',
  contributor: 'Contributor',
  translator: 'Translator',
  seriesEditor: 'Series Editor',
  bookAuthor: 'Book Author',
  reviewedAuthor: 'Reviewed Author',
  inventor: 'Inventor',
  attorneyAgent: 'Attorney/Agent',
  director: 'Director',
  producer: 'Producer',
  scriptwriter: 'Scriptwriter',
  presenter: 'Presenter',
  counsel: 'Counsel',
  interviewee: 'Interviewee',
  interviewer: 'Interviewer',
  cartographer: 'Cartographer',
  programmer: 'Programmer',
  artist: 'Artist',
  recipient: 'Recipient',
  performer: 'Performer',
  composer: 'Composer',
  wordsBy: 'Words By',
  guest: 'Guest',
  castMember: 'Cast Member',
  podcaster: 'Podcaster',
  sponsor: 'Sponsor',
};

// ── 2. Standard Field Metadata Definitions ──────────────────────────────────
export const FIELD_DEFINITIONS: Record<string, SchemaFieldDefinition> = {
  title: { field: 'title', label: 'Title', type: 'text', category: 'core', placeholder: 'Title of the document...' },
  abstractNote: { field: 'abstractNote', label: 'Abstract', type: 'textarea', category: 'core', placeholder: 'Summary or abstract...' },
  publicationTitle: { field: 'publicationTitle', label: 'Publication', type: 'text', category: 'venue', placeholder: 'Journal / Periodical name...' },
  bookTitle: { field: 'bookTitle', label: 'Book Title', type: 'text', category: 'venue', placeholder: 'Title of the complete book...' },
  proceedingsTitle: { field: 'proceedingsTitle', label: 'Proceedings Title', type: 'text', category: 'venue', placeholder: 'Conference proceedings title...' },
  conferenceName: { field: 'conferenceName', label: 'Conference Name', type: 'text', category: 'venue', placeholder: 'Name of the conference...' },
  websiteTitle: { field: 'websiteTitle', label: 'Website Title', type: 'text', category: 'venue', placeholder: 'Name of the website...' },
  websiteType: { field: 'websiteType', label: 'Website Type', type: 'text', category: 'venue', placeholder: 'e.g. Blog, Documentation...' },
  university: { field: 'university', label: 'University', type: 'text', category: 'venue', placeholder: 'University or Degree Granting Institution...' },
  institution: { field: 'institution', label: 'Institution', type: 'text', category: 'venue', placeholder: 'Institution / Organization...' },
  publisher: { field: 'publisher', label: 'Publisher', type: 'text', category: 'venue', placeholder: 'Publishing company...' },
  place: { field: 'place', label: 'Place', type: 'text', category: 'venue', placeholder: 'Place / City / Country...' },
  country: { field: 'country', label: 'Country', type: 'text', category: 'venue', placeholder: 'Country of patent / jurisdiction...' },
  assignee: { field: 'assignee', label: 'Assignee', type: 'text', category: 'venue', placeholder: 'Company or assignee...' },
  issuingAuthority: { field: 'issuingAuthority', label: 'Issuing Authority', type: 'text', category: 'venue', placeholder: 'Patent or Trademark office...' },

  volume: { field: 'volume', label: 'Volume', type: 'text', category: 'publication', placeholder: 'Volume #' },
  issue: { field: 'issue', label: 'Issue', type: 'text', category: 'publication', placeholder: 'Issue #' },
  pages: { field: 'pages', label: 'Pages', type: 'text', category: 'publication', placeholder: 'e.g. 100–125' },
  section: { field: 'section', label: 'Section', type: 'text', category: 'publication', placeholder: 'Section #' },
  edition: { field: 'edition', label: 'Edition', type: 'text', category: 'publication', placeholder: 'e.g. 2nd ed.' },
  numPages: { field: 'numPages', label: '# of Pages', type: 'text', category: 'publication', placeholder: 'Total page count' },
  numberOfVolumes: { field: 'numberOfVolumes', label: '# of Volumes', type: 'text', category: 'publication', placeholder: 'Total volumes' },
  series: { field: 'series', label: 'Series', type: 'text', category: 'publication', placeholder: 'Series name' },
  seriesTitle: { field: 'seriesTitle', label: 'Series Title', type: 'text', category: 'publication', placeholder: 'Series title' },
  seriesText: { field: 'seriesText', label: 'Series Text', type: 'text', category: 'publication', placeholder: 'Series description' },
  seriesNumber: { field: 'seriesNumber', label: 'Series Number', type: 'text', category: 'publication', placeholder: 'Series number' },
  journalAbbreviation: { field: 'journalAbbreviation', label: 'Journal Abbr', type: 'text', category: 'publication', placeholder: 'e.g. Phys. Rev. Lett.' },
  
  date: { field: 'date', label: 'Date', type: 'date', category: 'publication', placeholder: 'YYYY or YYYY-MM-DD' },
  filingDate: { field: 'filingDate', label: 'Filing Date', type: 'date', category: 'publication', placeholder: 'YYYY-MM-DD' },
  accessDate: { field: 'accessDate', label: 'Accessed', type: 'date', category: 'publication', placeholder: 'YYYY-MM-DD' },

  DOI: { field: 'DOI', label: 'DOI', type: 'text', category: 'identifiers', placeholder: '10.xxxx/...' },
  ISBN: { field: 'ISBN', label: 'ISBN', type: 'text', category: 'identifiers', placeholder: '978-...' },
  ISSN: { field: 'ISSN', label: 'ISSN', type: 'text', category: 'identifiers', placeholder: 'xxxx-xxxx' },
  patentNumber: { field: 'patentNumber', label: 'Patent #', type: 'text', category: 'identifiers', placeholder: 'Patent number' },
  applicationNumber: { field: 'applicationNumber', label: 'Application #', type: 'text', category: 'identifiers', placeholder: 'Application number' },
  reportNumber: { field: 'reportNumber', label: 'Report #', type: 'text', category: 'identifiers', placeholder: 'Report number' },
  reportType: { field: 'reportType', label: 'Report Type', type: 'text', category: 'publication', placeholder: 'Technical Report / White Paper' },
  thesisType: { field: 'thesisType', label: 'Type', type: 'text', category: 'publication', placeholder: 'Ph.D. Dissertation / Master\'s Thesis' },
  genre: { field: 'genre', label: 'Genre / Type', type: 'text', category: 'publication', placeholder: 'Document genre' },
  identifier: { field: 'identifier', label: 'Identifier', type: 'text', category: 'identifiers', placeholder: 'Unique resource ID' },
  versionNumber: { field: 'versionNumber', label: 'Version', type: 'text', category: 'publication', placeholder: 'e.g. 1.0.0' },
  legalStatus: { field: 'legalStatus', label: 'Legal Status', type: 'text', category: 'publication', placeholder: 'e.g. Active, Expired, Pending' },

  url: { field: 'url', label: 'URL', type: 'url', category: 'identifiers', placeholder: 'https://...' },
  language: { field: 'language', label: 'Language', type: 'text', category: 'publication', placeholder: 'e.g. en, vi, fr' },
  shortTitle: { field: 'shortTitle', label: 'Short Title', type: 'text', category: 'core', placeholder: 'Abbreviated title' },
  citationKey: { field: 'citationKey', label: 'Citation Key', type: 'text', category: 'identifiers', placeholder: 'e.g. author2024title' },

  archive: { field: 'archive', label: 'Archive', type: 'text', category: 'archive', placeholder: 'Archive repository' },
  archiveLocation: { field: 'archiveLocation', label: 'Loc. in Archive', type: 'text', category: 'archive', placeholder: 'Location within archive' },
  libraryCatalog: { field: 'libraryCatalog', label: 'Library Catalog', type: 'text', category: 'archive', placeholder: 'Catalog or database name' },
  callNumber: { field: 'callNumber', label: 'Call Number', type: 'text', category: 'archive', placeholder: 'Library call number' },

  rights: { field: 'rights', label: 'Rights', type: 'text', category: 'extra', placeholder: 'Copyright / License' },
  extra: { field: 'extra', label: 'Extra', type: 'textarea', category: 'extra', placeholder: 'Extra fields (key: value)...' },
};

function buildFields(keys: string[]): SchemaFieldDefinition[] {
  return keys
    .map((k) => FIELD_DEFINITIONS[k] || { field: k, label: k, type: 'text', category: 'extra' });
}

function buildCreators(roles: string[], primaryRole: string = 'author'): SchemaCreatorTypeDefinition[] {
  return roles.map((r) => ({
    creatorType: r,
    label: ALL_CREATOR_TYPES[r] || r,
    primary: r === primaryRole,
  }));
}

// ── 3. Complete Zotero Item Types Registry (36+ types) ────────────────────────
export const ZOTERO_SCHEMA_ITEM_TYPES: Record<string, SchemaItemTypeDefinition> = {
  // ── A. Academic & Scientific ───────────────────────────────────────────────
  journalArticle: {
    itemType: 'journalArticle',
    label: 'Journal Article',
    category: 'academic',
    primaryCreatorType: 'author',
    creatorTypes: buildCreators(['author', 'editor', 'translator', 'reviewedAuthor', 'contributor'], 'author'),
    fields: buildFields([
      'title', 'abstractNote', 'publicationTitle', 'volume', 'issue', 'pages', 'date',
      'series', 'seriesTitle', 'seriesText', 'journalAbbreviation', 'DOI', 'ISSN',
      'shortTitle', 'url', 'accessDate', 'archive', 'archiveLocation', 'libraryCatalog', 'callNumber',
      'rights', 'extra'
    ]),
  },
  conferencePaper: {
    itemType: 'conferencePaper',
    label: 'Conference Paper',
    category: 'academic',
    primaryCreatorType: 'author',
    creatorTypes: buildCreators(['author', 'editor', 'translator', 'seriesEditor', 'contributor'], 'author'),
    fields: buildFields([
      'title', 'abstractNote', 'proceedingsTitle', 'conferenceName', 'place', 'publisher',
      'volume', 'pages', 'series', 'date', 'DOI', 'ISBN',
      'shortTitle', 'url', 'accessDate', 'archive', 'archiveLocation', 'libraryCatalog', 'callNumber',
      'rights', 'extra'
    ]),
  },
  preprint: {
    itemType: 'preprint',
    label: 'Preprint',
    category: 'academic',
    primaryCreatorType: 'author',
    creatorTypes: buildCreators(['author', 'contributor', 'reviewedAuthor'], 'author'),
    fields: buildFields([
      'title', 'abstractNote', 'genre', 'institution', 'series', 'seriesNumber', 'date',
      'DOI', 'citationKey', 'shortTitle', 'url', 'accessDate', 'archive', 'archiveLocation', 'libraryCatalog', 'callNumber',
      'rights', 'extra'
    ]),
  },
  thesis: {
    itemType: 'thesis',
    label: 'Thesis / Dissertation',
    category: 'academic',
    primaryCreatorType: 'author',
    creatorTypes: buildCreators(['author', 'contributor'], 'author'),
    fields: buildFields([
      'title', 'abstractNote', 'thesisType', 'university', 'place', 'date',
      'numPages', 'language', 'shortTitle', 'url', 'accessDate', 'archive', 'archiveLocation', 'libraryCatalog', 'callNumber',
      'rights', 'extra'
    ]),
  },
  report: {
    itemType: 'report',
    label: 'Report',
    category: 'academic',
    primaryCreatorType: 'author',
    creatorTypes: buildCreators(['author', 'editor', 'translator', 'seriesEditor', 'contributor'], 'author'),
    fields: buildFields([
      'title', 'abstractNote', 'reportNumber', 'reportType', 'institution', 'place', 'date',
      'pages', 'language', 'shortTitle', 'url', 'accessDate', 'archive', 'archiveLocation', 'libraryCatalog', 'callNumber',
      'rights', 'extra'
    ]),
  },
  dataset: {
    itemType: 'dataset',
    label: 'Dataset',
    category: 'academic',
    primaryCreatorType: 'author',
    creatorTypes: buildCreators(['author', 'contributor'], 'author'),
    fields: buildFields([
      'title', 'abstractNote', 'identifier', 'genre', 'versionNumber', 'publisher', 'place',
      'date', 'DOI', 'shortTitle', 'url', 'accessDate', 'rights', 'extra'
    ]),
  },
  presentation: {
    itemType: 'presentation',
    label: 'Presentation',
    category: 'academic',
    primaryCreatorType: 'presenter',
    creatorTypes: buildCreators(['presenter', 'contributor'], 'presenter'),
    fields: buildFields([
      'title', 'abstractNote', 'genre', 'place', 'date', 'conferenceName',
      'shortTitle', 'url', 'accessDate', 'rights', 'extra'
    ]),
  },

  // ── B. Books & Long-form Publications ───────────────────────────────────────
  book: {
    itemType: 'book',
    label: 'Book',
    category: 'books',
    primaryCreatorType: 'author',
    creatorTypes: buildCreators(['author', 'editor', 'translator', 'seriesEditor', 'contributor'], 'author'),
    fields: buildFields([
      'title', 'abstractNote', 'series', 'seriesNumber', 'volume', 'numberOfVolumes',
      'edition', 'place', 'publisher', 'date', 'numPages', 'language', 'ISBN',
      'shortTitle', 'url', 'accessDate', 'archive', 'archiveLocation', 'libraryCatalog', 'callNumber',
      'rights', 'extra'
    ]),
  },
  bookSection: {
    itemType: 'bookSection',
    label: 'Book Section / Chapter',
    category: 'books',
    primaryCreatorType: 'author',
    creatorTypes: buildCreators(['author', 'bookAuthor', 'editor', 'translator', 'seriesEditor', 'contributor'], 'author'),
    fields: buildFields([
      'title', 'abstractNote', 'bookTitle', 'series', 'seriesNumber', 'volume', 'numberOfVolumes',
      'edition', 'place', 'publisher', 'date', 'pages', 'language', 'ISBN',
      'shortTitle', 'url', 'accessDate', 'archive', 'archiveLocation', 'libraryCatalog', 'callNumber',
      'rights', 'extra'
    ]),
  },
  manuscript: {
    itemType: 'manuscript',
    label: 'Manuscript',
    category: 'books',
    primaryCreatorType: 'author',
    creatorTypes: buildCreators(['author', 'translator', 'contributor'], 'author'),
    fields: buildFields([
      'title', 'abstractNote', 'genre', 'place', 'date', 'numPages', 'language',
      'shortTitle', 'url', 'accessDate', 'archive', 'archiveLocation', 'libraryCatalog', 'callNumber',
      'rights', 'extra'
    ]),
  },
  dictionaryEntry: {
    itemType: 'dictionaryEntry',
    label: 'Dictionary Entry',
    category: 'books',
    primaryCreatorType: 'author',
    creatorTypes: buildCreators(['author', 'editor', 'translator', 'seriesEditor', 'contributor'], 'author'),
    fields: buildFields([
      'title', 'abstractNote', 'bookTitle', 'series', 'seriesNumber', 'volume', 'numberOfVolumes',
      'edition', 'place', 'publisher', 'date', 'pages', 'language', 'ISBN',
      'shortTitle', 'url', 'accessDate', 'archive', 'archiveLocation', 'libraryCatalog', 'callNumber',
      'rights', 'extra'
    ]),
  },
  encyclopediaArticle: {
    itemType: 'encyclopediaArticle',
    label: 'Encyclopedia Article',
    category: 'books',
    primaryCreatorType: 'author',
    creatorTypes: buildCreators(['author', 'editor', 'translator', 'seriesEditor', 'contributor'], 'author'),
    fields: buildFields([
      'title', 'abstractNote', 'bookTitle', 'series', 'seriesNumber', 'volume', 'numberOfVolumes',
      'edition', 'place', 'publisher', 'date', 'pages', 'language', 'ISBN',
      'shortTitle', 'url', 'accessDate', 'archive', 'archiveLocation', 'libraryCatalog', 'callNumber',
      'rights', 'extra'
    ]),
  },

  // ── C. Articles & Periodicals ──────────────────────────────────────────────
  magazineArticle: {
    itemType: 'magazineArticle',
    label: 'Magazine Article',
    category: 'articles',
    primaryCreatorType: 'author',
    creatorTypes: buildCreators(['author', 'reviewedAuthor', 'translator', 'contributor'], 'author'),
    fields: buildFields([
      'title', 'abstractNote', 'publicationTitle', 'volume', 'issue', 'date', 'pages',
      'language', 'ISSN', 'shortTitle', 'url', 'accessDate', 'archive', 'archiveLocation', 'libraryCatalog', 'callNumber',
      'rights', 'extra'
    ]),
  },
  newspaperArticle: {
    itemType: 'newspaperArticle',
    label: 'Newspaper Article',
    category: 'articles',
    primaryCreatorType: 'author',
    creatorTypes: buildCreators(['author', 'reviewedAuthor', 'translator', 'contributor'], 'author'),
    fields: buildFields([
      'title', 'abstractNote', 'publicationTitle', 'place', 'section', 'date', 'pages',
      'language', 'shortTitle', 'url', 'accessDate', 'archive', 'archiveLocation', 'libraryCatalog', 'callNumber',
      'rights', 'extra'
    ]),
  },
  blogPost: {
    itemType: 'blogPost',
    label: 'Blog Post',
    category: 'articles',
    primaryCreatorType: 'author',
    creatorTypes: buildCreators(['author', 'commenter', 'contributor'], 'author'),
    fields: buildFields([
      'title', 'abstractNote', 'websiteTitle', 'websiteType', 'date',
      'shortTitle', 'url', 'accessDate', 'rights', 'extra'
    ]),
  },
  forumPost: {
    itemType: 'forumPost',
    label: 'Forum Post',
    category: 'articles',
    primaryCreatorType: 'author',
    creatorTypes: buildCreators(['author', 'contributor'], 'author'),
    fields: buildFields([
      'title', 'abstractNote', 'forumTitle', 'date',
      'shortTitle', 'url', 'accessDate', 'rights', 'extra'
    ]),
  },
  webpage: {
    itemType: 'webpage',
    label: 'Web Page',
    category: 'articles',
    primaryCreatorType: 'author',
    creatorTypes: buildCreators(['author', 'contributor', 'translator'], 'author'),
    fields: buildFields([
      'title', 'abstractNote', 'websiteTitle', 'websiteType', 'date',
      'shortTitle', 'url', 'accessDate', 'rights', 'extra'
    ]),
  },

  // ── D. Legal & Official ────────────────────────────────────────────────────
  patent: {
    itemType: 'patent',
    label: 'Patent',
    category: 'legal',
    primaryCreatorType: 'inventor',
    creatorTypes: buildCreators(['inventor', 'attorneyAgent', 'contributor'], 'inventor'),
    fields: buildFields([
      'title', 'abstractNote', 'place', 'country', 'assignee', 'issuingAuthority',
      'patentNumber', 'applicationNumber', 'date', 'filingDate', 'legalStatus',
      'shortTitle', 'url', 'accessDate', 'rights', 'extra'
    ]),
  },
  statute: {
    itemType: 'statute',
    label: 'Statute',
    category: 'legal',
    primaryCreatorType: 'author',
    creatorTypes: buildCreators(['author', 'contributor'], 'author'),
    fields: buildFields([
      'title', 'abstractNote', 'nameOfAct', 'code', 'codeNumber', 'publicLawNumber',
      'dateEnacted', 'pages', 'section', 'session', 'history', 'shortTitle', 'url', 'accessDate', 'rights', 'extra'
    ]),
  },
  bill: {
    itemType: 'bill',
    label: 'Bill',
    category: 'legal',
    primaryCreatorType: 'sponsor',
    creatorTypes: buildCreators(['sponsor', 'cosponsor', 'contributor'], 'sponsor'),
    fields: buildFields([
      'title', 'abstractNote', 'billNumber', 'code', 'codeVolume', 'section',
      'legislativeBody', 'session', 'history', 'date', 'language', 'url', 'accessDate', 'rights', 'extra'
    ]),
  },
  case: {
    itemType: 'case',
    label: 'Case',
    category: 'legal',
    primaryCreatorType: 'author',
    creatorTypes: buildCreators(['author', 'counsel', 'contributor'], 'author'),
    fields: buildFields([
      'title', 'abstractNote', 'court', 'dateDecided', 'docketNumber', 'reporter', 'reporterVolume',
      'firstPage', 'history', 'language', 'shortTitle', 'url', 'accessDate', 'rights', 'extra'
    ]),
  },
  hearing: {
    itemType: 'hearing',
    label: 'Hearing',
    category: 'legal',
    primaryCreatorType: 'contributor',
    creatorTypes: buildCreators(['contributor'], 'contributor'),
    fields: buildFields([
      'title', 'abstractNote', 'committee', 'legislativeBody', 'session', 'history',
      'documentNumber', 'pages', 'place', 'publisher', 'date', 'language', 'shortTitle', 'url', 'accessDate', 'rights', 'extra'
    ]),
  },
  standard: {
    itemType: 'standard',
    label: 'Standard',
    category: 'legal',
    primaryCreatorType: 'author',
    creatorTypes: buildCreators(['author', 'contributor'], 'author'),
    fields: buildFields([
      'title', 'abstractNote', 'organization', 'institution', 'standardNumber', 'versionNumber',
      'date', 'place', 'publisher', 'shortTitle', 'url', 'accessDate', 'rights', 'extra'
    ]),
  },

  // ── E. Documents & Media ───────────────────────────────────────────────────
  document: {
    itemType: 'document',
    label: 'Document',
    category: 'documents',
    primaryCreatorType: 'author',
    creatorTypes: buildCreators(['author', 'editor', 'translator', 'contributor'], 'author'),
    fields: buildFields([
      'title', 'abstractNote', 'publisher', 'date', 'language',
      'shortTitle', 'url', 'accessDate', 'archive', 'archiveLocation', 'libraryCatalog', 'callNumber',
      'rights', 'extra'
    ]),
  },
  film: {
    itemType: 'film',
    label: 'Film',
    category: 'media',
    primaryCreatorType: 'director',
    creatorTypes: buildCreators(['director', 'producer', 'scriptwriter', 'contributor'], 'director'),
    fields: buildFields([
      'title', 'abstractNote', 'distributor', 'genre', 'runningTime', 'date',
      'shortTitle', 'url', 'accessDate', 'archive', 'archiveLocation', 'libraryCatalog', 'callNumber',
      'rights', 'extra'
    ]),
  },
  audioRecording: {
    itemType: 'audioRecording',
    label: 'Audio Recording',
    category: 'media',
    primaryCreatorType: 'performer',
    creatorTypes: buildCreators(['performer', 'composer', 'wordsBy', 'contributor'], 'performer'),
    fields: buildFields([
      'title', 'abstractNote', 'audioRecordingFormat', 'seriesTitle', 'volume', 'numberOfVolumes',
      'place', 'label', 'date', 'runningTime', 'ISBN', 'shortTitle', 'url', 'accessDate', 'rights', 'extra'
    ]),
  },
  videoRecording: {
    itemType: 'videoRecording',
    label: 'Video Recording',
    category: 'media',
    primaryCreatorType: 'director',
    creatorTypes: buildCreators(['director', 'producer', 'scriptwriter', 'castMember', 'contributor'], 'director'),
    fields: buildFields([
      'title', 'abstractNote', 'videoRecordingFormat', 'seriesTitle', 'volume', 'numberOfVolumes',
      'place', 'studio', 'date', 'runningTime', 'ISBN', 'shortTitle', 'url', 'accessDate', 'rights', 'extra'
    ]),
  },
  podcast: {
    itemType: 'podcast',
    label: 'Podcast',
    category: 'media',
    primaryCreatorType: 'podcaster',
    creatorTypes: buildCreators(['podcaster', 'guest', 'contributor'], 'podcaster'),
    fields: buildFields([
      'title', 'abstractNote', 'seriesTitle', 'episodeNumber', 'audioFileType',
      'runningTime', 'url', 'accessDate', 'rights', 'extra'
    ]),
  },
  interview: {
    itemType: 'interview',
    label: 'Interview',
    category: 'media',
    primaryCreatorType: 'interviewee',
    creatorTypes: buildCreators(['interviewee', 'interviewer', 'translator', 'contributor'], 'interviewee'),
    fields: buildFields([
      'title', 'abstractNote', 'interviewMedium', 'date', 'language',
      'shortTitle', 'url', 'accessDate', 'rights', 'extra'
    ]),
  },
  letter: {
    itemType: 'letter',
    label: 'Letter',
    category: 'documents',
    primaryCreatorType: 'author',
    creatorTypes: buildCreators(['author', 'recipient', 'contributor'], 'author'),
    fields: buildFields([
      'title', 'abstractNote', 'letterType', 'date', 'language',
      'shortTitle', 'url', 'accessDate', 'archive', 'archiveLocation', 'libraryCatalog', 'callNumber',
      'rights', 'extra'
    ]),
  },
  email: {
    itemType: 'email',
    label: 'E-mail',
    category: 'documents',
    primaryCreatorType: 'author',
    creatorTypes: buildCreators(['author', 'recipient', 'contributor'], 'author'),
    fields: buildFields([
      'title', 'abstractNote', 'subject', 'date',
      'shortTitle', 'url', 'accessDate', 'rights', 'extra'
    ]),
  },
  map: {
    itemType: 'map',
    label: 'Map',
    category: 'documents',
    primaryCreatorType: 'cartographer',
    creatorTypes: buildCreators(['cartographer', 'seriesEditor', 'contributor'], 'cartographer'),
    fields: buildFields([
      'title', 'abstractNote', 'mapType', 'scale', 'seriesTitle', 'edition',
      'place', 'publisher', 'date', 'ISBN', 'shortTitle', 'url', 'accessDate', 'rights', 'extra'
    ]),
  },
  artwork: {
    itemType: 'artwork',
    label: 'Artwork',
    category: 'media',
    primaryCreatorType: 'artist',
    creatorTypes: buildCreators(['artist', 'contributor'], 'artist'),
    fields: buildFields([
      'title', 'abstractNote', 'artworkMedium', 'artworkSize', 'place', 'date',
      'language', 'shortTitle', 'url', 'accessDate', 'archive', 'archiveLocation', 'libraryCatalog', 'callNumber',
      'rights', 'extra'
    ]),
  },
  computerProgram: {
    itemType: 'computerProgram',
    label: 'Computer Program / Software',
    category: 'documents',
    primaryCreatorType: 'programmer',
    creatorTypes: buildCreators(['programmer', 'contributor'], 'programmer'),
    fields: buildFields([
      'title', 'abstractNote', 'seriesTitle', 'versionNumber', 'date', 'system',
      'place', 'company', 'ISBN', 'shortTitle', 'url', 'accessDate', 'rights', 'extra'
    ]),
  },
};

/**
 * Get schema definition for an item type with graceful fallback to journalArticle
 */
export function getZoteroItemTypeDefinition(itemType?: string | null): SchemaItemTypeDefinition {
  if (!itemType) return ZOTERO_SCHEMA_ITEM_TYPES.journalArticle;
  return ZOTERO_SCHEMA_ITEM_TYPES[itemType] || ZOTERO_SCHEMA_ITEM_TYPES.journalArticle;
}

/**
 * Normalize any input string into a valid canonical Zotero item type
 */
export function normalizeCanonicalItemType(type?: string | null): string {
  if (!type || typeof type !== 'string') return 'journalArticle';
  const clean = type.trim();
  if (ZOTERO_SCHEMA_ITEM_TYPES[clean]) return clean;

  const lower = clean.toLowerCase();
  if (lower.includes('journal') || lower.includes('article')) return 'journalArticle';
  if (lower.includes('booksection') || lower.includes('chapter')) return 'bookSection';
  if (lower.includes('book')) return 'book';
  if (lower.includes('conference') || lower.includes('proceeding')) return 'conferencePaper';
  if (lower.includes('preprint') || lower.includes('arxiv') || lower.includes('biorxiv') || lower.includes('ssrn')) return 'preprint';
  if (lower.includes('thesis') || lower.includes('dissertation')) return 'thesis';
  if (lower.includes('report') || lower.includes('whitepaper')) return 'report';
  if (lower.includes('patent')) return 'patent';
  if (lower.includes('dataset') || lower.includes('data')) return 'dataset';
  if (lower.includes('webpage') || lower.includes('website') || lower.includes('web')) return 'webpage';
  if (lower.includes('standard') || lower.includes('iso')) return 'standard';
  if (lower.includes('presentation') || lower.includes('slides')) return 'presentation';
  if (lower.includes('software') || lower.includes('program') || lower.includes('code')) return 'computerProgram';
  if (lower.includes('statute') || lower.includes('law') || lower.includes('act')) return 'statute';
  if (lower.includes('bill')) return 'bill';
  if (lower.includes('case')) return 'case';
  if (lower.includes('hearing')) return 'hearing';
  if (lower.includes('magazine')) return 'magazineArticle';
  if (lower.includes('newspaper') || lower.includes('news')) return 'newspaperArticle';
  if (lower.includes('blog')) return 'blogPost';
  if (lower.includes('forum')) return 'forumPost';
  if (lower.includes('manuscript')) return 'manuscript';
  if (lower.includes('map')) return 'map';
  if (lower.includes('film') || lower.includes('movie')) return 'film';
  if (lower.includes('audio') || lower.includes('music')) return 'audioRecording';
  if (lower.includes('video')) return 'videoRecording';
  if (lower.includes('podcast')) return 'podcast';
  if (lower.includes('interview')) return 'interview';
  if (lower.includes('letter')) return 'letter';
  if (lower.includes('email') || lower.includes('e-mail')) return 'email';
  if (lower.includes('artwork')) return 'artwork';
  if (lower.includes('document')) return 'document';

  return 'journalArticle';
}
