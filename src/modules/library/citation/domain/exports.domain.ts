import {
  ExportFormatType,
  CsvExportItem,
} from '@/modules/library/citation/types/exports.types';
import { CslJsonMapper, CslSourceItem } from './csl-json.mapper';

const MIME_TYPES: Record<ExportFormatType, string> = {
  bibtex: 'application/x-bibtex',
  ris: 'application/x-research-info-systems',
  'csl-json': 'application/json',
  csl_json: 'application/json',
  csv: 'text/csv; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
};

const FILE_EXTENSIONS: Record<ExportFormatType, string> = {
  bibtex: 'bib',
  ris: 'ris',
  'csl-json': 'json',
  csl_json: 'json',
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
 * Escapes and sanitizes a value for CSV output (RFC 4180 + formula injection defense).
 */
export function escapeCsvField(val: unknown): string {
  if (val === null || val === undefined) return '""';
  const str =
    typeof val === 'string'
      ? val
      : typeof val === 'number' || typeof val === 'boolean'
        ? String(val)
        : '';
  const needsFormulaGuard =
    /^[=+\-@\t\r]/.test(str) && !/^-\d+(\.\d+)?$/.test(str);
  const safeStr = needsFormulaGuard ? `'${str}` : str;
  return `"${safeStr.replace(/"/g, '""')}"`;
}

/**
 * Serializes a list of items into standard RFC 4180 CSV string (18-column schema with CRLF).
 */
export function formatCsvExport(
  items: ReadonlyArray<CsvExportItem | CslSourceItem>,
): string {
  const headers = [
    'id',
    'title',
    'authors',
    'year',
    'publicationTitle',
    'publisher',
    'doi',
    'itemType',
    'citationKey',
    'url',
    'abstract',
    'volume',
    'issue',
    'pages',
    'isbn',
    'issn',
    'pmid',
    'arxivId',
  ];

  const rows = items.map((it) => {
    const csl = CslJsonMapper.toCsl(it as CslSourceItem);
    const rec = it as Record<string, unknown>;
    const meta = (
      rec.metadata && typeof rec.metadata === 'object' ? rec.metadata : {}
    ) as Record<string, unknown>;
    const publicationTitle =
      (typeof it.publicationTitle === 'string' ? it.publicationTitle : '') ||
      (typeof rec.bookTitle === 'string' ? rec.bookTitle : '') ||
      (typeof rec.proceedingsTitle === 'string' ? rec.proceedingsTitle : '') ||
      (typeof meta.bookTitle === 'string' ? meta.bookTitle : '') ||
      (typeof meta.proceedingsTitle === 'string' ? meta.proceedingsTitle : '') ||
      csl['container-title'] ||
      '';
    const citationKey =
      (typeof it.citationKey === 'string' ? it.citationKey : '') ||
      (typeof csl['citation-key'] === 'string' ? csl['citation-key'] : '');
    const arxivId =
      typeof csl._arxivId === 'string'
        ? csl._arxivId
        : typeof rec.arxivId === 'string'
          ? rec.arxivId
          : '';
    const authors =
      Array.isArray(it.authors) && it.authors.length > 0
        ? it.authors.join('; ')
        : CslJsonMapper.getAuthorNames(it as CslSourceItem).join('; ');

    return [
      escapeCsvField(it.id),
      escapeCsvField(it.title || ''),
      escapeCsvField(authors),
      escapeCsvField(it.year),
      escapeCsvField(publicationTitle),
      escapeCsvField(
        (typeof it.publisher === 'string' ? it.publisher : '') ||
          csl.publisher ||
          '',
      ),
      escapeCsvField(it.doi || csl.DOI || ''),
      escapeCsvField(it.itemType || ''),
      escapeCsvField(citationKey),
      escapeCsvField(it.url || csl.URL || ''),
      escapeCsvField(
        (typeof rec.abstract === 'string' ? rec.abstract : '') ||
          csl.abstract ||
          '',
      ),
      escapeCsvField(rec.volume ?? csl.volume ?? ''),
      escapeCsvField(rec.issue ?? csl.issue ?? ''),
      escapeCsvField(
        (typeof rec.pages === 'string' ? rec.pages : '') || csl.page || '',
      ),
      escapeCsvField(
        (typeof rec.isbn === 'string' ? rec.isbn : '') || csl.ISBN || '',
      ),
      escapeCsvField(
        (typeof rec.issn === 'string' ? rec.issn : '') || csl.ISSN || '',
      ),
      escapeCsvField(
        (typeof rec.pmid === 'string' ? rec.pmid : '') || csl.PMID || '',
      ),
      escapeCsvField(arxivId),
    ];
  });

  return [headers.join(','), ...rows.map((r) => r.join(','))].join('\r\n');
}
