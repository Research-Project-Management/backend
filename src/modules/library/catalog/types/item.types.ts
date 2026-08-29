export interface CreatorInput {
  name?: string;
  firstName?: string;
  lastName?: string;
  creatorType?: string;
}

export type IdentifierScheme = 'doi' | 'arxiv' | 'pmid' | 'pmcid' | 'isbn' | 'issn';
