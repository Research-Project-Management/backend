export type ExportFormatType =
  'bibtex' | 'ris' | 'csl-json' | 'csv' | 'markdown';

export interface BurnableAnnotation {
  pageIndex: number;
  type?: string;
  color?: string;
  quoteText?: string;
  comment?: string;
  rectCoords?: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    rects?: Array<{ x: number; y: number; width: number; height: number }>;
  };
}

export interface ExportResult {
  format: ExportFormatType;
  filename: string;
  mimeType: string;
  content: string;
  itemCount: number;
  /** True when the library has more items than the export cap (1000). */
  truncated: boolean;
}

export interface CsvExportItem {
  id: string;
  title?: string | null;
  authors?: string[];
  year?: number | null;
  publicationTitle?: string | null;
  publisher?: string | null;
  doi?: string | null;
  itemType?: string | null;
  citationKey?: string | null;
  url?: string | null;
}
