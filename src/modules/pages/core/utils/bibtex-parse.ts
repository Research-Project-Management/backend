/**
 * modules/pages/core/utils/bibtex-parse.ts
 * Lightweight pure BibTeX parser backed by `@citation-js/plugin-bibtex`
 * shared between structure symbol extraction and citation tooling without upward coupling.
 */

import { plugins } from '@citation-js/core';
import '@citation-js/plugin-bibtex';

export interface ParsedBibtexEntry {
  key: string;
  type: string;
  title?: string;
  author?: string;
  year?: string;
  journal?: string;
  booktitle?: string;
  publisher?: string;
  doi?: string;
  url?: string;
  abstract?: string;
  volume?: string;
  number?: string;
  pages?: string;
}

interface CitationJsRawEntry {
  type?: string;
  label?: string;
  properties?: Record<string, unknown>;
}

function asCleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
  return trimmed || undefined;
}

export function parseBibtexEntries(rawContent: string): ParsedBibtexEntry[] {
  if (!rawContent || !rawContent.trim()) return [];
  try {
    const raw = plugins.input.chainLink(rawContent) as
      | CitationJsRawEntry[]
      | undefined;
    if (!Array.isArray(raw)) return [];

    const out: ParsedBibtexEntry[] = [];
    for (const item of raw) {
      const key = item.label?.trim();
      if (!key) continue;
      const props = item.properties ?? {};
      out.push({
        key,
        type: (item.type || 'article').toLowerCase(),
        title: asCleanString(props.title),
        author: asCleanString(props.author),
        year: asCleanString(props.year ?? props.date),
        journal: asCleanString(props.journal ?? props.journaltitle),
        booktitle: asCleanString(props.booktitle),
        publisher: asCleanString(props.publisher),
        doi: asCleanString(props.doi),
        url: asCleanString(props.url),
        abstract: asCleanString(props.abstract),
        volume: asCleanString(props.volume),
        number: asCleanString(props.number),
        pages: asCleanString(props.pages),
      });
    }
    return out;
  } catch {
    return [];
  }
}
