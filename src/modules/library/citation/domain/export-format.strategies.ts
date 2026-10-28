import { ExportItemRecord } from './export-item.types';
import {
  ExportFormatType,
  ExportResult,
} from '@/modules/library/citation/types/exports.types';
import { CitationItemInput } from '@/modules/library/citation/types/citation.types';
import { CslJsonMapper } from './csl-json.mapper';
import { escapeCsvField, formatCsvExport } from './exports.domain';

export interface ICitationFormatterPort {
  formatItem(
    item: CitationItemInput,
    styleId: string,
  ): { bibliography: string };
}

export interface IExportFormatStrategy {
  readonly format: ExportFormatType;
  readonly aliases?: readonly string[];
  readonly extension: string;
  readonly mimeType: string;
  exportItems(params: {
    items: ExportItemRecord[];
    timestamp: string;
    truncated?: boolean;
    citationFormatter: ICitationFormatterPort;
  }): ExportResult;
}

export function toCitationItemInput(
  it: ExportItemRecord,
  overrideKey?: string,
): CitationItemInput {
  const csl = CslJsonMapper.toCsl(it);
  const effectiveKey =
    overrideKey ||
    it.citationKey ||
    (typeof csl['citation-key'] === 'string' ? csl['citation-key'] : undefined);
  return {
    ...(it as unknown as Record<string, unknown>),
    id: effectiveKey || it.id,
    itemType: it.itemType ?? 'journalArticle',
    title: it.title,
    authors: CslJsonMapper.getAuthorNames(it),
    publicationTitle: it.publicationTitle ?? csl['container-title'],
    publisher: csl.publisher,
    year: it.year ?? undefined,
    volume: csl.volume !== undefined ? String(csl.volume) : undefined,
    issue: csl.issue !== undefined ? String(csl.issue) : undefined,
    pages: csl.page,
    doi: it.doi || csl.DOI || undefined,
    isbn: csl.ISBN || undefined,
    issn: csl.ISSN || undefined,
    pmid: csl.PMID || undefined,
    pmcid: csl.PMCID || undefined,
    arxivId: typeof csl._arxivId === 'string' ? csl._arxivId : undefined,
    edition: csl.edition !== undefined ? String(csl.edition) : undefined,
    place: csl['publisher-place'] || undefined,
    series: csl['collection-title'] || undefined,
    url: it.url ?? csl.URL ?? undefined,
    abstract: it.abstract ?? csl.abstract ?? undefined,
    citationKey: effectiveKey,
    contributors: it.contributors,
    creators: it.contributors,
    metadata: it.metadata,
    updatedAt: it.updatedAt ?? undefined,
    version: it.version ?? undefined,
  };
}

export function formatItemsAsBibtex(
  items: ExportItemRecord[],
  citationFormatter: ICitationFormatterPort,
): string {
  const entries = items.map((it) => {
    const res = citationFormatter.formatItem(toCitationItemInput(it), 'bibtex');
    return res.bibliography;
  });
  return entries.join('\n\n');
}

export class BibtexExportStrategy implements IExportFormatStrategy {
  readonly format: ExportFormatType = 'bibtex';
  readonly extension = 'bib';
  readonly mimeType = 'application/x-bibtex';

  exportItems(params: {
    items: ExportItemRecord[];
    timestamp: string;
    truncated?: boolean;
    citationFormatter: ICitationFormatterPort;
  }): ExportResult {
    const { items, timestamp, truncated, citationFormatter } = params;
    return {
      format: 'bibtex',
      filename: `library-export-${timestamp}.bib`,
      mimeType: this.mimeType,
      content: formatItemsAsBibtex(items, citationFormatter),
      itemCount: items.length,
      truncated,
    };
  }
}

export class RisExportStrategy implements IExportFormatStrategy {
  readonly format: ExportFormatType = 'ris';
  readonly extension = 'ris';
  readonly mimeType = 'application/x-research-info-systems';

  exportItems(params: {
    items: ExportItemRecord[];
    timestamp: string;
    truncated?: boolean;
    citationFormatter: ICitationFormatterPort;
  }): ExportResult {
    const { items, timestamp, truncated, citationFormatter } = params;
    const entries = items.map((it) => {
      const res = citationFormatter.formatItem(toCitationItemInput(it), 'ris');
      return res.bibliography;
    });

    return {
      format: 'ris',
      filename: `library-export-${timestamp}.ris`,
      mimeType: this.mimeType,
      content: entries.join('\n'),
      itemCount: items.length,
      truncated,
    };
  }
}

export class CslJsonExportStrategy implements IExportFormatStrategy {
  readonly format: ExportFormatType = 'csl-json';
  readonly aliases = ['csl_json'] as const;
  readonly extension = 'json';
  readonly mimeType = 'application/json';

  exportItems(params: {
    items: ExportItemRecord[];
    timestamp: string;
    truncated?: boolean;
  }): ExportResult {
    const { items, timestamp, truncated } = params;
    const cslList = items.map((it) => {
      const rawCsl = { ...CslJsonMapper.toCsl(it) };
      const arxivId =
        typeof rawCsl._arxivId === 'string' ? rawCsl._arxivId.trim() : '';
      if (arxivId) {
        const existingNote =
          typeof rawCsl.note === 'string' ? rawCsl.note.trim() : '';
        if (!existingNote) {
          rawCsl.note = `arXiv: ${arxivId}`;
        } else if (!/arxiv\s*:/i.test(existingNote)) {
          rawCsl.note = `${existingNote}\narXiv: ${arxivId}`;
        }
      }
      const cleaned: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rawCsl)) {
        if (!k.startsWith('_')) {
          cleaned[k] = v;
        }
      }
      return cleaned;
    });

    return {
      format: 'csl-json',
      filename: `library-export-${timestamp}.json`,
      mimeType: this.mimeType,
      content: JSON.stringify(cslList, null, 2),
      itemCount: items.length,
      truncated,
    };
  }
}

export class CsvExportStrategy implements IExportFormatStrategy {
  readonly format: ExportFormatType = 'csv';
  readonly extension = 'csv';
  readonly mimeType = 'text/csv; charset=utf-8';

  exportItems(params: {
    items: ExportItemRecord[];
    timestamp: string;
    truncated?: boolean;
  }): ExportResult {
    const { items, timestamp, truncated } = params;
    return {
      format: 'csv',
      filename: `library-export-${timestamp}.csv`,
      mimeType: this.mimeType,
      content: formatCsvExport(items),
      itemCount: items.length,
      truncated,
    };
  }
}

export class MarkdownExportStrategy implements IExportFormatStrategy {
  readonly format: ExportFormatType = 'markdown';
  readonly extension = 'md';
  readonly mimeType = 'text/markdown';

  exportItems(params: {
    items: ExportItemRecord[];
    timestamp: string;
    truncated?: boolean;
  }): ExportResult {
    const { items, timestamp, truncated } = params;
    const escapeMd = (str: string) =>
      str.replace(/([[\]()])/g, '\\$1').replace(/\r?\n+/g, ' ');
    const mdLines = [`# Library Export (${timestamp})\n`];
    items.forEach((it, idx) => {
      const auth = escapeMd(
        CslJsonMapper.getAuthorNames(it).join(', ') || 'Unknown Authors',
      );
      const safeTitle = escapeMd(it.title || '');
      const yr = it.year ? ` (${it.year})` : '';
      mdLines.push(`${idx + 1}. **${safeTitle}** — *${auth}*${yr}`);
      if (it.publicationTitle)
        mdLines.push(`   *Published in:* ${escapeMd(it.publicationTitle)}`);
      if (it.doi) {
        const safeDoiLabel = escapeMd(it.doi);
        const encodedDoi = encodeURI(it.doi.trim()).replace(
          /[()]/g,
          (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
        );
        mdLines.push(
          `   *DOI:* [${safeDoiLabel}](https://doi.org/${encodedDoi})`,
        );
      }
      mdLines.push('');
    });

    return {
      format: 'markdown',
      filename: `library-export-${timestamp}.md`,
      mimeType: this.mimeType,
      content: mdLines.join('\n'),
      itemCount: items.length,
      truncated,
    };
  }
}

export const EXPORT_FORMAT_STRATEGIES: readonly IExportFormatStrategy[] = [
  new BibtexExportStrategy(),
  new RisExportStrategy(),
  new CslJsonExportStrategy(),
  new CsvExportStrategy(),
  new MarkdownExportStrategy(),
];

const STRATEGY_LOOKUP = new Map<string, IExportFormatStrategy>();
for (const strategy of EXPORT_FORMAT_STRATEGIES) {
  STRATEGY_LOOKUP.set(strategy.format.toLowerCase(), strategy);
  for (const alias of strategy.aliases ?? []) {
    STRATEGY_LOOKUP.set(alias.toLowerCase(), strategy);
  }
}

export function resolveExportFormatStrategy(
  format: string,
): IExportFormatStrategy | undefined {
  if (!format) return undefined;
  return STRATEGY_LOOKUP.get(format.trim().toLowerCase());
}
