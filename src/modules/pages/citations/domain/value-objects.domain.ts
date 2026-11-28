/**
 * citations/domain/value-objects/citation-key.ts
 * Value Object representing a sanitized BibTeX citation key.
 * Enforces valid LaTeX citation key characters (alphanumeric, underscore, colon, hyphen).
 */

import { InvalidBibtexException } from './citations.errors';
import { stripCombiningDiacritics } from './bibtex-formatter.domain';

export class CitationKeyVo {
  private static readonly VALID_KEY_REGEX = /^[a-zA-Z0-9_:.-]+$/;

  private constructor(public readonly value: string) {}

  public static create(rawKey: string): CitationKeyVo {
    if (!rawKey || typeof rawKey !== 'string') {
      throw new InvalidBibtexException('Citation key cannot be empty');
    }

    const trimmed = rawKey.trim();
    if (!CitationKeyVo.VALID_KEY_REGEX.test(trimmed)) {
      throw new InvalidBibtexException(
        `Invalid citation key '${rawKey}'. Keys can only contain letters, numbers, underscores, colons, dots, and hyphens.`,
      );
    }

    return new CitationKeyVo(trimmed);
  }

  public static sanitize(input: string): string {
    return stripCombiningDiacritics(
      input.trim().replace(/\u0111/g, 'd').replace(/\u0110/g, 'D'),
    )
      .replace(/[\s/\\{},~#%&$]+/g, '_')
      .replace(/[^a-zA-Z0-9_:.-]/g, '')
      .replace(/^_+|_+$/g, '');
  }

  public equals(other: CitationKeyVo): boolean {
    return this.value === other.value;
  }

  public toString(): string {
    return this.value;
  }
}

/**
 * citations/domain/value-objects/author-list.ts
 * Value Object parsing and formatting BibTeX author strings for human display.
 */

export interface AuthorItem {
  fullName: string;
  lastName: string;
  firstName?: string;
}

export class AuthorListVo {
  public readonly authors: readonly AuthorItem[];

  constructor(rawAuthorString: string) {
    this.authors = Object.freeze(AuthorListVo.parseAuthors(rawAuthorString));
  }

  public static parseAuthors(raw: string): AuthorItem[] {
    if (!raw || typeof raw !== 'string') return [];

    // Split on BibTeX 'and' separator only at top-level (braceDepth === 0)
    // so corporate names like {Research and Development Lab} stay intact.
    const authorStrings = AuthorListVo.splitTopLevelAnd(raw);
    const parsed: AuthorItem[] = [];

    for (const a of authorStrings) {
      const trimmed = a.trim().replace(/^\{+|\}+$/g, '');
      if (!trimmed) continue;

      if (trimmed.includes(',')) {
        // Format: "Last, First" or "Last, Jr., First"
        const parts = trimmed.split(',').map((p) => p.trim());
        const lastName = parts[0] || '';
        const firstName = parts.slice(1).join(' ');
        parsed.push({
          fullName: `${firstName} ${lastName}`.trim(),
          lastName,
          firstName: firstName || undefined,
        });
      } else {
        // Format: "First Last"
        const words = trimmed.split(/\s+/);
        const lastName = words[words.length - 1] || '';
        const firstName = words.slice(0, -1).join(' ');
        parsed.push({
          fullName: trimmed,
          lastName,
          firstName: firstName || undefined,
        });
      }
    }

    return parsed;
  }

  private static splitTopLevelAnd(raw: string): string[] {
    const result: string[] = [];
    let braceDepth = 0;
    let start = 0;
    let i = 0;

    const andRe = /\s+and\s+/iy;
    while (i < raw.length) {
      const ch = raw[i];
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '{') {
        braceDepth++;
        i++;
        continue;
      }
      if (ch === '}') {
        if (braceDepth > 0) braceDepth--;
        i++;
        continue;
      }
      if (braceDepth === 0 && /\s/.test(ch)) {
        andRe.lastIndex = i;
        const match = andRe.exec(raw);
        if (match) {
          result.push(raw.slice(start, i));
          i += match[0].length;
          start = i;
          continue;
        }
      }
      i++;
    }

    if (start <= raw.length) {
      result.push(raw.slice(start));
    }
    return result;
  }

  /**
   * Generates academic short citation label (e.g. "Vaswani et al." or "Smith and Doe")
   */
  public toDisplayString(): string {
    if (this.authors.length === 0) return 'Unknown Author';
    if (this.authors.length === 1) return this.authors[0].lastName;
    if (this.authors.length === 2) {
      return `${this.authors[0].lastName} and ${this.authors[1].lastName}`;
    }
    return `${this.authors[0].lastName} et al.`;
  }

  public toFullNameList(): string[] {
    return this.authors.map((a) => a.fullName);
  }
}

/**
 * citations/domain/identifier.ts
 * Value Object identifying and standardizing DOI, arXiv, and ISBN identifiers.
 */

export type IdentifierType = 'doi' | 'arxiv' | 'isbn' | 'unknown';

export class IdentifierVo {
  private static readonly DOI_REGEX =
    /(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)?(10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+)/i;

  private static readonly ARXIV_REGEX =
    /(?:https?:\/\/arxiv\.org\/(?:abs|pdf)\/|arxiv:\s*)?(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})/i;

  private static readonly ISBN_REGEX =
    /(?:ISBN(?:-1[03])?:?\s*)?(?=[-0-9 ]{13}$|[-0-9X ]{10}$|[0-9X]{10}$|[0-9]{13}$)(?:97[89][- ]?)?[0-9]{1,5}[- ]?[0-9]+[- ]?[0-9]+[- ]?[0-9X]/i;

  private constructor(
    public readonly type: IdentifierType,
    public readonly raw: string,
    public readonly clean: string,
  ) {}

  public static parse(input: string): IdentifierVo {
    if (!input || typeof input !== 'string') {
      return new IdentifierVo('unknown', '', '');
    }

    const trimmed = input.trim();

    // 1. Check DOI
    const doiMatch = trimmed.match(IdentifierVo.DOI_REGEX);
    if (doiMatch && doiMatch[1]) {
      return new IdentifierVo('doi', trimmed, doiMatch[1]);
    }

    // 2. Check arXiv
    const arxivMatch = trimmed.match(IdentifierVo.ARXIV_REGEX);
    if (arxivMatch && arxivMatch[1]) {
      return new IdentifierVo('arxiv', trimmed, arxivMatch[1]);
    }

    // 3. Check ISBN
    const isbnMatch = trimmed.match(IdentifierVo.ISBN_REGEX);
    if (isbnMatch && isbnMatch[0]) {
      const cleanIsbn = isbnMatch[0].replace(/[^0-9X]/gi, '');
      return new IdentifierVo('isbn', trimmed, cleanIsbn);
    }

    return new IdentifierVo('unknown', trimmed, trimmed);
  }
}
