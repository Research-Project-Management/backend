/**
 * Citation Style Language (CSL) JSON Data Schema v1.0.2
 * Conforming to https://github.com/citation-style-language/schema
 */

export interface CslName {
  family?: string;
  given?: string;
  literal?: string;
  'dropping-particle'?: string;
  'non-dropping-particle'?: string;
  suffix?: string;
}

export interface CslDate {
  'date-parts': Array<Array<number | string>>;
  raw?: string;
  literal?: string;
}

export interface CslItemData {
  id: string;
  type: string;
  title: string;
  'title-short'?: string;
  author?: CslName[];
  editor?: CslName[];
  translator?: CslName[];
  'container-author'?: CslName[];
  'collection-editor'?: CslName[];
  composer?: CslName[];
  director?: CslName[];
  interviewer?: CslName[];
  recipient?: CslName[];
  'reviewed-author'?: CslName[];

  // Container & Publishing Information
  'container-title'?: string;
  'container-title-short'?: string;
  'collection-title'?: string;
  'collection-number'?: string | number;
  publisher?: string;
  'publisher-place'?: string;
  authority?: string;
  jurisdiction?: string;

  // Dates
  issued?: CslDate;
  accessed?: CslDate;
  submitted?: CslDate;

  // Locators & Numbers
  volume?: string | number;
  issue?: string | number;
  'number-of-volumes'?: string | number;
  edition?: string | number;
  page?: string;
  'page-first'?: string;
  'number-of-pages'?: string | number;
  section?: string;

  // Identifiers
  DOI?: string;
  ISBN?: string;
  ISSN?: string;
  PMID?: string;
  PMCID?: string;
  URL?: string;
  archive?: string;
  archive_location?: string;
  'call-number'?: string;

  // Classification & Content
  abstract?: string;
  keyword?: string;
  genre?: string;
  note?: string;
  version?: string;
  language?: string;
  status?: string;
}
