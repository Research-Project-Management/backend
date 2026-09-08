import { ExportFormatType, CsvExportItem } from '../types/exports.types';

const MIME_TYPES: Record<ExportFormatType, string> = {
  bibtex: 'application/x-bibtex',
  ris: 'application/x-research-info-systems',
  'csl-json': 'application/json',
  csv: 'text/csv; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
};

const FILE_EXTENSIONS: Record<ExportFormatType, string> = {
  bibtex: 'bib',
  ris: 'ris',
  'csl-json': 'json',
  csv: 'csv',
  markdown: 'md',
};

/**
 * Resolves appropriate MIME type for an export format.
 */
export function resolveExportMimeType(format: ExportFormatType): string {
  return MIME_TYPES[format] || 'application/octet-stream';
}

/**
 * Resolves file extension for an export format.
 */
export function resolveExportFileExtension(format: ExportFormatType): string {
  return FILE_EXTENSIONS[format] || 'txt';
}

/**
 * Generates standard timestamped export filename.
 */
export function generateExportFilename(
  format: ExportFormatType,
  timestamp: string = new Date().toISOString().replace(/[:.]/g, '-'),
): string {
  const ext = resolveExportFileExtension(format);
  return `library-export-${timestamp}.${ext}`;
}

/**
 * Serializes a list of items into standard RFC 4180 CSV string.
 */
export function formatCsvExport(items: CsvExportItem[]): string {
  const headers = [
    'id',
    'title',
    'authors',
    'year',
    'publicationTitle',
    'doi',
    'itemType',
  ];

  const escapeCsv = (val: unknown): string => {
    if (val === null || val === undefined) return '""';
    const str =
      typeof val === 'string'
        ? val
        : typeof val === 'number' || typeof val === 'boolean'
          ? String(val)
          : '';
    return `"${str.replace(/"/g, '""')}"`;
  };

  const rows = items.map((it) => [
    escapeCsv(it.id),
    escapeCsv(it.title || ''),
    escapeCsv((it.authors || []).join('; ')),
    it.year ?? '',
    escapeCsv(it.publicationTitle || ''),
    escapeCsv(it.doi || ''),
    escapeCsv(it.itemType || ''),
  ]);

  return [headers.join(','), ...rows.map((r) => r.join(','))].join('\r\n');
}
