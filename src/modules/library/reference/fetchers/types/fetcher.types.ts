export interface ProvenanceMetadata {
  originProvider:
    | 'CrossRef'
    | 'arXiv'
    | 'PubMed'
    | 'OpenLibrary'
    | 'SemanticScholar'
    | 'Unpaywall'
    | 'LocalPDFExtraction';
  resolvedAt: string;
  canonicalId: string;
  canonicalUrl?: string;
  confidenceScore: number;
  rawSnapshotHash?: string;
  isOpenAccess: boolean;
  openAccessPdfUrl?: string;
}

export interface UnifiedAcademicMetadata {
  doi?: string;
  arxivId?: string;
  pmid?: string;
  isbn?: string;
  title: string;
  authors: string[];
  year: number | null;
  journal?: string;
  publisher?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  issn?: string;
  url?: string;
  abstract?: string;
  tldr?: string;
  keywords?: string[];
  citationCount?: number;
  openAccessPdfUrl?: string;
  itemType: string;
  citationKey?: string;
  provenance?: ProvenanceMetadata;
}
