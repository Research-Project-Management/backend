export const EXPORT_ENGINE_PORT = Symbol('EXPORT_ENGINE_PORT');

export type ExportFormat =
  'bibtex' | 'ris' | 'csv' | 'json' | 'zotero-rdf' | 'endnote-xml';

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

export interface ExportItemData {
  id: string;
  title: string;
  itemType?: string;
  doi?: string | null;
  isbn?: string | null;
  year?: number | string | null;
  authors?: string[];
  publicationTitle?: string | null;
  publisher?: string | null;
  volume?: string | null;
  issue?: string | null;
  pages?: string | null;
  abstract?: string | null;
  url?: string | null;
  tags?: string[];
  citationKey?: string | null;
  [key: string]: unknown;
}

export interface ExportResult {
  format: ExportFormatType | ExportFormat;
  filename: string;
  mimeType: string;
  content: string;
  itemCount: number;
  truncated?: boolean;
}

export interface IExportEnginePort {
  export(
    items: ExportItemData[],
    format: ExportFormat,
    options?: {
      includeAbstract?: boolean;
      includeNotes?: boolean;
      includeTags?: boolean;
    },
  ): Promise<ExportResult>;

  getSupportedFormats(): ExportFormat[];
}
