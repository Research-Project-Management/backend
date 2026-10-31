import { Injectable, Optional } from '@nestjs/common';
import {
  CitationStyleId,
  CitationItemInput,
  FormattedCitationResult,
} from '@/modules/library/citation/types/citation.types';
import { CslJsonMapper } from './csl-json.mapper';
import {
  CslFallbackFormatter,
  ICslFallbackFormatter,
} from './csl-style-formatter.domain';

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

  constructor(
    @Optional()
    private readonly formatter: ICslFallbackFormatter = new CslFallbackFormatter(),
  ) {
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
   * fails completely or is unavailable. Delegates raw BibTeX/RIS rendering
   * to CslStyleFormatterService and author normalization to CslJsonMapper.
   */
  formatFallback(
    item: CitationItemInput,
    styleId: CitationStyleId = 'apa-7th',
    index: number = 1,
  ): FormattedCitationResult {
    const cslItem = CslJsonMapper.toCsl(item);
    const meta = this.styleMap.get(styleId);
    const category = meta?.category || 'author-date';

    if (category === 'raw') {
      if (styleId === 'bibtex') {
        const key = item.citationKey || item.id || `ref_${index}`;
        return {
          styleId,
          inText: `\\cite{${key}}`,
          bibliography: this.formatter.fallbackBibtex({
            ...cslItem,
            id: key,
          }),
        };
      }
      if (styleId === 'ris') {
        return {
          styleId,
          inText: item.title || 'Untitled',
          bibliography: this.formatter.fallbackRis(cslItem),
        };
      }
    }

    const authors = cslItem.author || [];
    const firstAuthor =
      authors[0]?.family || authors[0]?.literal || 'Anonymous';
    const authorStr =
      authors.length > 0
        ? authors.map((a) => a.family || a.literal || 'Anonymous').join(', ')
        : 'Anonymous';
    const year =
      cslItem.issued?.['date-parts']?.[0]?.[0] ||
      item.year ||
      (item.date ? new Date(item.date).getFullYear() : 'n.d.');
    const title = item.title || 'Untitled';
    const source = item.publicationTitle || item.journal || '';

    if (category === 'numeric') {
      return {
        styleId,
        inText: `[${index}]`,
        bibliography: `[${index}] ${authorStr}. "${title}."${source ? ` ${source},` : ''} ${year}.`,
      };
    }

    return {
      styleId,
      inText: `(${firstAuthor}, ${year})`,
      bibliography: `${authorStr} (${year}). ${title}.${source ? ` ${source}.` : ''}`,
    };
  }
}
