export interface UnifiedAcademicMetadata {
  doi?: string;
  arxivId?: string;
  title: string;
  authors: string[];
  year: number | null;
  journal?: string;
  publisher?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  issn?: string;
  isbn?: string;
  url?: string;
  abstract?: string;
  tldr?: string;
  citationCount?: number;
  openAccessPdfUrl?: string;
  itemType: string;
  citationKey?: string;
}
