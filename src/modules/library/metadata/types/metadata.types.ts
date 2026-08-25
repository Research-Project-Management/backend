export interface ProvenanceMetadata {
  originProvider:
    | 'CrossRef'
    | 'arXiv'
    | 'PubMed'
    | 'OpenLibrary'
    | 'SemanticScholar'
    | 'OpenAlex'
    | 'Unpaywall'
    | 'LocalPDFExtraction'
    | 'Fallback';
  resolvedAt: string;
  canonicalId: string;
  canonicalUrl?: string;
  confidenceScore: number;
  rawSnapshotHash?: string;
  isOpenAccess: boolean;
  openAccessPdfUrl?: string;
}

export interface UnifiedAcademicMetadata {
  // Identifiers
  doi?: string;
  arxivId?: string;
  pmid?: string;
  pmcid?: string;
  issn?: string;
  isbn?: string;
  url?: string;

  // Bibliographic core
  title: string;
  shortTitle?: string;
  authors: string[];
  editors?: string[];
  year: number | null;
  publicationDate?: string;
  itemType: string;

  // Venue & Series
  journal?: string;
  publicationTitle?: string;
  journalAbbr?: string;
  publisher?: string;
  place?: string;
  volume?: string;
  issue?: string;
  section?: string;
  pages?: string;
  series?: string;
  seriesTitle?: string;
  language?: string;

  // Content & AI
  abstract?: string;
  tldr?: string;
  keywords?: string[];

  // Impact & Open Access
  citationCount?: number;
  referenceCount?: number;
  influentialCitationCount?: number;
  openAccessPdfUrl?: string;
  rights?: string;
  license?: string;

  // Citation Key & Zotero Extensibility
  citationKey?: string;
  archive?: string;
  archiveLocation?: string;
  callNumber?: string;
  extra?: string;

  // Provenance trace
  provenance?: ProvenanceMetadata;
}
