import { Injectable } from '@nestjs/common';
import {
  CitationStyleId,
  CitationItemInput,
  FormattedCitationResult,
  CitationCreator,
} from '@/modules/library/citation/types/citation.types';

export interface CitationStyleDefinition {
  id: CitationStyleId;
  name: string;
  category: 'author-date' | 'numeric' | 'label' | 'raw';
  format(item: CitationItemInput, index?: number): FormattedCitationResult;
}

export interface StyleSummary {
  id: CitationStyleId;
  name: string;
  shortTitle?: string;
  category: 'author-date' | 'numeric' | 'label' | 'raw';
  isPrimary?: boolean;
}

export const BUILTIN_SPECIAL_STYLES = new Set([
  'auto',
  'auto-numeric',
  'bibtex',
  'ris',
  'tcvn',
  'tcvn-numeric',
]);

export const NUMERIC_STYLE_TOKENS = [
  'vancouver',
  'nature',
  'science',
  'ieee',
  'the-lancet',
  'pnas',
  'plos',
];

/**
 * Normalizes citation style ID for the CSL execution engine.
 */
export function normalizeEngineStyleId(styleId: string): string {
  const s = (styleId || 'auto').toLowerCase().trim();
  if (s === 'auto' || s === 'default' || !s) return 'auto';
  if (s === 'auto-numeric' || s === 'numeric') return 'auto-numeric';
  if (s === 'apa-7th' || s === 'apa') return 'apa';
  if (s === 'mla-9th' || s === 'mla') return 'mla';
  if (s === 'chicago-author-date' || s === 'chicago') return 'chicago';
  if (s === 'harvard' || s === 'harvard1') return 'harvard1';
  if (
    s === 'tcvn' ||
    s === 'tcvn-author-date' ||
    s === 'bo-giao-duc' ||
    s === 'vietnam'
  ) {
    return 'tcvn';
  }
  if (s === 'tcvn-numeric') return 'tcvn-numeric';
  return s;
}

/**
 * Authoritative catalogue of supported citation styles in the Flux system.
 * The primary rendering engine is CslEngineService (@citation-js).
 * This registry maintains style metadata definitions and provides a minimal
 * emergency fallback formatter in case the CSL rendering engine encounters an error.
 */
export const SUPPORTED_CITATION_STYLES: ReadonlyArray<StyleSummary> = [
  {
    id: 'auto',
    name: 'Tự động nhận diện (Auto-Detect)',
    shortTitle: 'Tự động',
    category: 'author-date',
    isPrimary: true,
  },
  {
    id: 'apa-7th',
    name: 'American Psychological Association 7th edition',
    shortTitle: 'APA',
    category: 'author-date',
    isPrimary: true,
  },
  {
    id: 'ieee',
    name: 'IEEE',
    shortTitle: 'IEEE',
    category: 'numeric',
    isPrimary: true,
  },
  {
    id: 'mla-9th',
    name: 'Modern Language Association 9th edition',
    shortTitle: 'MLA',
    category: 'author-date',
    isPrimary: true,
  },
  {
    id: 'bibtex',
    name: 'BibTeX',
    shortTitle: 'BibTeX',
    category: 'raw',
    isPrimary: true,
  },
  {
    id: 'chicago',
    name: 'Chicago Manual of Style 17th edition (Author-Date)',
    shortTitle: 'Chicago',
    category: 'author-date',
    isPrimary: false,
  },
  {
    id: 'harvard',
    name: 'Harvard Reference Format 1 (Author-Date)',
    shortTitle: 'Harvard',
    category: 'author-date',
    isPrimary: false,
  },
  {
    id: 'nature',
    name: 'Nature',
    shortTitle: 'Nature',
    category: 'numeric',
    isPrimary: false,
  },
  {
    id: 'vancouver',
    name: 'Vancouver',
    shortTitle: 'Vancouver',
    category: 'numeric',
    isPrimary: false,
  },
  {
    id: 'tcvn',
    name: 'Tiêu chuẩn Việt Nam (TCVN / Bộ Giáo dục & Đào tạo)',
    shortTitle: 'TCVN',
    category: 'author-date',
    isPrimary: true,
  },
  {
    id: 'tcvn-numeric',
    name: 'Tiêu chuẩn Việt Nam (TCVN - Đánh số)',
    shortTitle: 'TCVN (Số)',
    category: 'numeric',
    isPrimary: false,
  },
  {
    id: 'ris',
    name: 'Research Information Systems (RIS)',
    shortTitle: 'RIS',
    category: 'raw',
    isPrimary: false,
  },
];

export const MAX_DYNAMIC_CSL_STYLES = 200;

@Injectable()
export class CslStyleRegistry {
  private readonly styleMap = new Map<CitationStyleId, StyleSummary>();
  private readonly staticStyleIds = new Set<string>();
  private readonly dynamicStyleIds = new Set<string>();

  constructor() {
    for (const style of SUPPORTED_CITATION_STYLES) {
      this.styleMap.set(style.id, style);
      this.staticStyleIds.add(style.id);
    }
    const aliases: StyleSummary[] = [
      {
        id: 'apa',
        name: 'American Psychological Association (APA)',
        shortTitle: 'APA',
        category: 'author-date',
        isPrimary: true,
      },
      {
        id: 'mla',
        name: 'Modern Language Association (MLA)',
        shortTitle: 'MLA',
        category: 'author-date',
        isPrimary: true,
      },
      {
        id: 'chicago-author-date',
        name: 'Chicago (Author-Date)',
        shortTitle: 'Chicago',
        category: 'author-date',
        isPrimary: false,
      },
      {
        id: 'tcvn-author-date',
        name: 'Tiêu chuẩn Việt Nam (TCVN / Bộ Giáo dục & Đào tạo)',
        shortTitle: 'TCVN',
        category: 'author-date',
        isPrimary: true,
      },
      {
        id: 'bo-giao-duc',
        name: 'Bộ Giáo dục & Đào tạo (Việt Nam)',
        shortTitle: 'Bộ GD&ĐT',
        category: 'author-date',
        isPrimary: false,
      },
      {
        id: 'vietnam',
        name: 'Tiêu chuẩn Việt Nam (TCVN)',
        shortTitle: 'TCVN',
        category: 'author-date',
        isPrimary: false,
      },
    ];
    for (const alias of aliases) {
      this.styleMap.set(alias.id, alias);
      this.staticStyleIds.add(alias.id);
    }
  }

  has(styleId: string): boolean {
    if (!styleId) return false;
    return this.styleMap.has(styleId);
  }

  registerStyle(style: StyleSummary): void {
    if (this.staticStyleIds.has(style.id)) {
      this.styleMap.set(style.id, style);
      return;
    }

    if (this.dynamicStyleIds.has(style.id)) {
      this.dynamicStyleIds.delete(style.id);
    } else if (this.dynamicStyleIds.size >= MAX_DYNAMIC_CSL_STYLES) {
      const oldestId = this.dynamicStyleIds.values().next().value;
      if (oldestId) {
        this.dynamicStyleIds.delete(oldestId);
        this.styleMap.delete(oldestId);
      }
    }

    this.dynamicStyleIds.add(style.id);
    this.styleMap.set(style.id, style);
  }

  getStyle(styleId: CitationStyleId): CitationStyleDefinition {
    const meta = this.styleMap.get(styleId);
    if (meta) {
      return {
        ...meta,
        format: (item: CitationItemInput, index?: number) =>
          this.formatFallback(item, styleId, index),
      };
    }

    return {
      id: styleId,
      name: styleId,
      category: 'author-date',
      format: (item: CitationItemInput, index?: number) =>
        this.formatFallback(item, styleId, index),
    };
  }

  listStyles(): StyleSummary[] {
    return [...SUPPORTED_CITATION_STYLES];
  }

  /**
   * Minimal resilient fallback formatter used only if CslEngineService
   * fails completely or is unavailable.
   */
  formatFallback(
    item: CitationItemInput,
    styleId: CitationStyleId = 'apa-7th',
    index: number = 1,
  ): FormattedCitationResult {
    const authors = this.parseAuthors(item);
    const firstAuthor = authors[0]?.lastName || authors[0]?.name || 'Anonymous';
    const authorStr =
      authors.length > 0
        ? authors.map((a) => a.lastName || a.name || 'Anonymous').join(', ')
        : 'Anonymous';
    const year =
      item.year || (item.date ? new Date(item.date).getFullYear() : 'n.d.');
    const title = item.title || 'Untitled';
    const source = item.publicationTitle || item.journal || '';

    const meta = this.styleMap.get(styleId);
    const category = meta?.category || 'author-date';

    let inText = `(${firstAuthor}, ${year})`;
    let bibliography = `${authorStr} (${year}). ${title}.${source ? ` ${source}.` : ''}`;

    if (category === 'numeric') {
      inText = `[${index}]`;
      bibliography = `[${index}] ${authorStr}. "${title}."${source ? ` ${source},` : ''} ${year}.`;
    } else if (category === 'raw') {
      if (styleId === 'bibtex') {
        const key = item.citationKey || item.id || `ref_${index}`;
        inText = `\\cite{${key}}`;
        const entryType =
          item.itemType === 'book'
            ? 'book'
            : item.itemType === 'bookSection'
              ? 'incollection'
              : item.itemType === 'conferencePaper'
                ? 'inproceedings'
                : item.itemType === 'thesis'
                  ? 'phdthesis'
                  : item.itemType === 'report'
                    ? 'techreport'
                    : 'article';

        const bibtexAuthors =
          authors.length > 0
            ? authors
                .map((a) => {
                  if (a.lastName && a.firstName) {
                    return `${a.lastName}, ${a.firstName}`;
                  }
                  if (a.lastName) return a.lastName;
                  if (a.name) {
                    const trimmed = a.name.trim();
                    if (trimmed.includes(',')) return trimmed;
                    const parts = trimmed.split(/\s+/);
                    if (parts.length > 1) {
                      const last = parts.pop();
                      return `${last}, ${parts.join(' ')}`;
                    }
                    return trimmed;
                  }
                  return 'Anonymous';
                })
                .join(' and ')
            : 'Anonymous';

        const bibFields: string[] = [
          `  title = {${title}}`,
          `  author = {${bibtexAuthors}}`,
          `  year = {${year}}`,
        ];
        if (source) {
          const containerKey =
            entryType === 'incollection' || entryType === 'inproceedings'
              ? 'booktitle'
              : 'journal';
          bibFields.push(`  ${containerKey} = {${source}}`);
        }
        if (item.doi) bibFields.push(`  doi = {${item.doi}}`);
        if (item.isbn) bibFields.push(`  isbn = {${item.isbn}}`);
        if (item.issn) bibFields.push(`  issn = {${item.issn}}`);
        if (item.pmid) bibFields.push(`  pmid = {${item.pmid}}`);
        if (item.pmcid) bibFields.push(`  pmcid = {${item.pmcid}}`);
        if (item.arxivId) {
          bibFields.push(`  eprint = {${item.arxivId}}`);
          bibFields.push(`  archiveprefix = {arXiv}`);
        }
        bibliography = `@${entryType}{${key},\n${bibFields.join(',\n')}\n}`;
      } else if (styleId === 'ris') {
        inText = title;
        bibliography = `TY  - JOUR\nTI  - ${title}\nAU  - ${firstAuthor}\nPY  - ${year}\nER  -`;
      }
    }

    return {
      styleId,
      inText,
      bibliography,
    };
  }

  private parseAuthors(item: CitationItemInput): CitationCreator[] {
    const list =
      Array.isArray(item.creators) && item.creators.length > 0
        ? item.creators
        : Array.isArray(item.contributors) && item.contributors.length > 0
          ? item.contributors
          : null;

    if (list) {
      return list.map((c) => ({
        firstName: c.firstName ?? null,
        lastName: c.lastName ?? null,
        name: c.name || (c.fullName ? c.fullName : null),
        creatorType: c.creatorType || c.role || 'author',
      }));
    }
    if (item.authors && item.authors.length > 0) {
      return item.authors.map((a) => {
        const trimmed = a.trim();
        if (trimmed.includes(',')) {
          const [last, ...rest] = trimmed.split(',').map((s) => s.trim());
          return { firstName: rest.join(' '), lastName: last };
        }
        const parts = trimmed.split(/\s+/);
        if (parts.length === 1) return { lastName: parts[0] };
        const lastName = parts.pop();
        const firstName = parts.join(' ');
        return { firstName, lastName };
      });
    }
    return [{ lastName: 'Anonymous' }];
  }
}
