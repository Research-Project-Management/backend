/**
 * CitationKey Value Object.
 * Enforces BibTeX-compliant citation key structure (alphanumeric with hyphens/colons).
 */
export class CitationKeyVo {
  private readonly _value: string;

  private static readonly KEY_REGEX = /^[a-zA-Z0-9_:.#$%&-]+$/;

  private constructor(value: string) {
    this._value = value;
  }

  public static create(
    rawKey: string | null | undefined,
  ): CitationKeyVo | null {
    if (!rawKey || typeof rawKey !== 'string') {
      return null;
    }

    const cleaned = rawKey.trim();
    if (!cleaned) {
      return null;
    }

    if (!CitationKeyVo.KEY_REGEX.test(cleaned)) {
      throw new Error(`Invalid Citation Key format: "${rawKey}"`);
    }

    return new CitationKeyVo(cleaned);
  }

  public get value(): string {
    return this._value;
  }

  public equals(other?: CitationKeyVo | null): boolean {
    if (!other) return false;
    return this._value === other._value;
  }

  public toString(): string {
    return this._value;
  }
}
