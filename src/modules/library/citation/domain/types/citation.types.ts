export type CitationStyleId =
  | 'apa'
  | 'apa-7th'
  | 'ieee'
  | 'nature'
  | 'harvard'
  | 'chicago'
  | 'chicago-author-date'
  | 'mla'
  | 'mla-9th'
  | 'vancouver'
  | 'bibtex'
  | 'ris'
  | (string & {});

export interface CitationCreator {
  firstName?: string | null;
  lastName?: string | null;
  name?: string | null;
  creatorType?: string | null;
}

export interface CitationItemInput {
  id?: string;
  itemType: string;
  title: string;
  creators?: CitationCreator[];
  authors?: string[];
  publicationTitle?: string | null;
  journal?: string | null;
  publisher?: string | null;
  volume?: string | null;
  issue?: string | null;
  pages?: string | null;
  year?: number | null;
  date?: string | null;
  doi?: string | null;
  url?: string | null;
  citationKey?: string | null;
  city?: string | null;
  edition?: string | null;
  abstract?: string | null;
}

export interface FormattedCitationResult {
  styleId: CitationStyleId;
  inText: string;
  bibliography: string;
  bibliographyHtml?: string;
  source?: 'publisher' | 'csl-engine';
}

export interface ReferenceData {
  doi?: string;
  title: string;
  authors?: string[];
  creators?: Array<{
    creatorType?: string;
    name?: string;
    firstName?: string;
    lastName?: string;
  }>;
  year?: number | string;
  journal?: string;
  publicationTitle?: string;
  publicationDate?: string;
  publisher?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  issn?: string;
  isbn?: string;
  arxivId?: string;
  pmid?: string;
  pmcid?: string;
  url?: string;
  openAccessPdfUrl?: string;
  abstract?: string;
  citationCount?: number | string | null;
  keywords?: string[];
  tags?: string[];
  type?: string;
  itemType?: string;
  containerTitle?: string;
  score?: number;
  extraFields?: Record<string, unknown>;
  provenance?: Record<string, unknown> | null;
  [key: string]: unknown;
}
