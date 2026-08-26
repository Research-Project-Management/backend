export interface ReferenceManagerCreator {
  creatorType: string;
  firstName?: string;
  lastName?: string;
  name?: string;
}

export interface ReferenceManagerTag {
  tag: string;
  type?: number;
}

export interface ReferenceManagerItemData {
  key?: string;
  version?: number;
  itemType: string;
  title: string;
  creators: ReferenceManagerCreator[];
  abstractNote?: string;
  publicationTitle?: string;
  journalAbbreviation?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  date?: string;
  series?: string;
  seriesTitle?: string;
  seriesText?: string;
  publisher?: string;
  place?: string;
  language?: string;
  ISBN?: string;
  ISSN?: string;
  DOI?: string;
  url?: string;
  accessDate?: string;
  archive?: string;
  archiveLocation?: string;
  callNumber?: string;
  rights?: string;
  extra?: string;
  tags?: ReferenceManagerTag[];
  collections?: string[];
  relations?: Record<string, string[]>;
  dateAdded?: string;
  dateModified?: string;
  [key: string]: unknown;
}

export interface CslAuthor {
  family?: string;
  given?: string;
  literal?: string;
}

export interface CslDate {
  'date-parts'?: (number | string)[][];
  raw?: string;
  literal?: string;
}

export interface CslItem {
  id: string;
  type: string;
  title: string;
  author?: CslAuthor[];
  editor?: CslAuthor[];
  translator?: CslAuthor[];
  issued?: CslDate;
  abstract?: string;
  'container-title'?: string;
  'collection-title'?: string;
  'journal-abbreviation'?: string;
  publisher?: string;
  'publisher-place'?: string;
  volume?: string | number;
  issue?: string | number;
  page?: string;
  DOI?: string;
  ISBN?: string;
  ISSN?: string;
  PMID?: string;
  PMCID?: string;
  URL?: string;
  language?: string;
  keyword?: string;
  note?: string;
}

export interface FormattedCitationResult {
  id: string;
  style: string;
  citation: string;
}

export interface BatchCitationResult {
  style: string;
  citations: Record<string, string>;
  total: number;
}
