/**
 * citations/core/domain/value-objects/author-list.vo.ts
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

    // BibTeX separates authors with the word " and " (case-insensitive)
    const authorStrings = raw.split(/\s+and\s+/i);
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

  /**
   * Generates academic short citation label (e.g. "Vaswani et al." or "Smith and Doe")
   */
  public toDisplayString(): string {
    if (this.authors.length === 0) return 'Unknown Author';
    if (this.authors.length === 1) return this.authors[0]!.lastName;
    if (this.authors.length === 2) {
      return `${this.authors[0]!.lastName} and ${this.authors[1]!.lastName}`;
    }
    return `${this.authors[0]!.lastName} et al.`;
  }

  public toFullNameList(): string[] {
    return this.authors.map((a) => a.fullName);
  }
}
