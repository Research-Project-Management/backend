import { Injectable } from '@nestjs/common';
import {
  CitationStyleId,
  CitationItemInput,
  FormattedCitationResult,
  CitationCreator,
} from '../types/citation.types';

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

@Injectable()
export class CslStyleRegistry {
  private readonly styleMap = new Map<CitationStyleId, StyleSummary>();

  constructor() {
    for (const style of SUPPORTED_CITATION_STYLES) {
      this.styleMap.set(style.id, style);
    }
    // Support common aliases
    this.styleMap.set('apa', {
      id: 'apa',
      name: 'American Psychological Association (APA)',
      shortTitle: 'APA',
      category: 'author-date',
      isPrimary: true,
    });
    this.styleMap.set('mla', {
      id: 'mla',
      name: 'Modern Language Association (MLA)',
      shortTitle: 'MLA',
      category: 'author-date',
      isPrimary: true,
    });
    this.styleMap.set('chicago-author-date', {
      id: 'chicago-author-date',
      name: 'Chicago (Author-Date)',
      shortTitle: 'Chicago',
      category: 'author-date',
      isPrimary: false,
    });
    this.styleMap.set('tcvn-author-date', {
      id: 'tcvn-author-date',
      name: 'Tiêu chuẩn Việt Nam (TCVN / Bộ Giáo dục & Đào tạo)',
      shortTitle: 'TCVN',
      category: 'author-date',
      isPrimary: true,
    });
    this.styleMap.set('bo-giao-duc', {
      id: 'bo-giao-duc',
      name: 'Bộ Giáo dục & Đào tạo (Việt Nam)',
      shortTitle: 'Bộ GD&ĐT',
      category: 'author-date',
      isPrimary: false,
    });
    this.styleMap.set('vietnam', {
      id: 'vietnam',
      name: 'Tiêu chuẩn Việt Nam (TCVN)',
      shortTitle: 'TCVN',
      category: 'author-date',
      isPrimary: false,
    });
  }

  has(styleId: string): boolean {
    if (!styleId) return false;
    return this.styleMap.has(styleId);
  }

  registerStyle(style: StyleSummary): void {
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

    // Dynamic on-demand style definition
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

        bibliography = `@${entryType}{${key},\n  title = {${title}},\n  author = {${bibtexAuthors}},\n  year = {${year}}\n}`;
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

  private parseAuthors(
    item: CitationItemInput & { contributors?: any[] },
  ): CitationCreator[] {
    const list =
      Array.isArray(item.creators) && item.creators.length > 0
        ? item.creators
        : Array.isArray(item.contributors) && item.contributors.length > 0
          ? item.contributors
          : null;

    if (list) {
      return list.map((c: any) => ({
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
