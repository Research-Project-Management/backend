/**
 * Export Engine Port — Discovery Domain Layer
 *
 * Application Use Cases call this port to export library items to various formats.
 * Infrastructure layer implements it (wrapping ExportsService, BibTeX/RIS generators).
 * Zero NestJS or Prisma imports in this file.
 */

export const EXPORT_ENGINE_PORT = Symbol('EXPORT_ENGINE_PORT');

export type ExportFormat =
  'bibtex' | 'ris' | 'csv' | 'json' | 'zotero-rdf' | 'endnote-xml';

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
  content: string;
  filename: string;
  mimeType: string;
  format: ExportFormat;
  itemCount: number;
}

export interface IExportEnginePort {
  /**
   * Export a list of items to the specified format.
   */
  export(
    items: ExportItemData[],
    format: ExportFormat,
    options?: {
      includeAbstract?: boolean;
      includeNotes?: boolean;
      includeTags?: boolean;
    },
  ): Promise<ExportResult>;

  /**
   * Get supported export formats.
   */
  getSupportedFormats(): ExportFormat[];
}
