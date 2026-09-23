/**
 * citations/core/domain/value-objects/citation-key.vo.ts
 * Value Object representing a sanitized BibTeX citation key.
 * Enforces valid LaTeX citation key characters (alphanumeric, underscore, colon, hyphen).
 */

import { InvalidBibtexException } from '../exceptions/invalid-bibtex.exception';

export class CitationKeyVo {
  private static readonly VALID_KEY_REGEX = /^[a-zA-Z0-9_:.\\-]+$/;

  private constructor(public readonly value: string) {}

  public static create(rawKey: string): CitationKeyVo {
    if (!rawKey || typeof rawKey !== 'string') {
      throw new InvalidBibtexException('Citation key cannot be empty');
    }

    const trimmed = rawKey.trim();
    if (!CitationKeyVo.VALID_KEY_REGEX.test(trimmed)) {
      throw new InvalidBibtexException(
        `Invalid citation key '${rawKey}'. Keys can only contain letters, numbers, underscores, colons, and hyphens.`
      );
    }

    return new CitationKeyVo(trimmed);
  }

  public static sanitize(input: string): string {
    return input
      .trim()
      .replace(/[\s/\\{},~#%&$]+/g, '_')
      .replace(/[^a-zA-Z0-9_:.\\-]/g, '')
      .replace(/^_+|_+$/g, '');
  }

  public equals(other: CitationKeyVo): boolean {
    return this.value === other.value;
  }

  public toString(): string {
    return this.value;
  }
}
