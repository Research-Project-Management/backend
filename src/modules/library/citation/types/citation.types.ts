export type CitationStyleId =
  | 'apa-7th'
  | 'ieee'
  | 'nature'
  | 'harvard'
  | 'chicago-author-date'
  | 'bibtex'
  | 'ris';

export interface CitationCreator {
  firstName?: string;
  lastName?: string;
  name?: string;
}

export interface CitationItemInput {
  id?: string;
  itemType: string;
  title: string;
  creators?: CitationCreator[];
  authors?: string[];
  publicationTitle?: string;
  journal?: string;
  publisher?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  year?: number;
  date?: string;
  doi?: string;
  url?: string;
  citationKey?: string;
  city?: string;
  edition?: string;
  abstract?: string;
}

export interface FormattedCitationResult {
  styleId: CitationStyleId;
  inText: string;
  bibliography: string;
}
