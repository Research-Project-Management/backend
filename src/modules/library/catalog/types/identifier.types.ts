export type IdentifierScheme =
  | 'doi'
  | 'arxiv'
  | 'pmid'
  | 'pmcid'
  | 'isbn'
  | 'issn'
  | 'uri'
  | 'custom';

export interface ItemIdentifier {
  id?: string;
  type: IdentifierScheme;
  value: string;
  canonicalUri?: string;
}

export interface ItemIdentifierInput {
  type: IdentifierScheme;
  value: string;
  canonicalUri?: string;
}
