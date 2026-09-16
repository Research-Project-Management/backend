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
  category: 'author-date' | 'numeric' | 'label' | 'raw';
}

/**
 * Authoritative catalogue of supported citation styles in the Flux system.
 * The primary rendering engine is CslEngineService (@citation-js).
 * This registry maintains style metadata definitions and provides a minimal
 * emergency fallback formatter in case the CSL rendering engine encounters an error.
 */
export const SUPPORTED_CITATION_STYLES: ReadonlyArray<StyleSummary> = [
  {
    id: 'apa-7th',
    name: 'American Psychological Association 7th edition',
    category: 'author-date',
  },
  {
    id: 'ieee',
    name: 'IEEE',
    category: 'numeric',
  },
  {
    id: 'nature',
    name: 'Nature',
    category: 'numeric',
  },
  {
    id: 'bibtex',
    name: 'BibTeX',
    category: 'raw',
  },
  {
    id: 'ris',
    name: 'Research Information Systems (RIS)',
    category: 'raw',
  },
  {
    id: 'mla-9th',
    name: 'Modern Language Association 9th edition',
    category: 'author-date',
  },
  {
    id: 'chicago',
    name: 'Chicago Manual of Style 17th edition (Author-Date)',
    category: 'author-date',
  },
  {
    id: 'harvard',
    name: 'Harvard Reference Format 1 (Author-Date)',
    category: 'author-date',
  },
  {
    id: 'vancouver',
    name: 'Vancouver',
    category: 'numeric',
  },
];

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
      category: 'author-date',
    });
    this.styleMap.set('mla', {
      id: 'mla',
      name: 'Modern Language Association (MLA)',
      category: 'author-date',
    });
    this.styleMap.set('chicago-author-date', {
      id: 'chicago-author-date',
      name: 'Chicago (Author-Date)',
      category: 'author-date',
    });
  }

  has(styleId: string): boolean {
    return this.styleMap.has(styleId as CitationStyleId);
  }

  getStyle(styleId: CitationStyleId): CitationStyleDefinition | undefined {
    const meta = this.styleMap.get(styleId);
    if (!meta) return undefined;
    return {
      ...meta,
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
    const firstAuthor =
      authors[0]?.lastName || authors[0]?.name || 'Anonymous';
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
        const key = item.citationKey || `ref_${index}`;
        inText = `\\cite{${key}}`;
        bibliography = `@article{${key},\n  title = {${title}},\n  author = {${authorStr}},\n  year = {${year}}\n}`;
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
    if (item.creators && item.creators.length > 0) {
      return item.creators;
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
