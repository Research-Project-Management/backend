export type SupportedCitationStyle =
  | 'apa'
  | 'harvard'
  | 'vancouver'
  | 'ieee'
  | 'chicago'
  | 'nature'
  | 'science'
  | (string & {});

/**
 * CitationStyle Value Object validating academic citation styles.
 * Supports any valid style slug from the 10,000+ CSL repository.
 */
export class CitationStyleVo {
  private readonly _value: string;

  private constructor(value: string) {
    this._value = value;
  }

  public static create(rawStyle?: string | null): CitationStyleVo {
    if (!rawStyle) return new CitationStyleVo('apa');
    const cleaned = rawStyle.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!cleaned) {
      return new CitationStyleVo('apa');
    }
    return new CitationStyleVo(cleaned);
  }

  public get value(): string {
    return this._value;
  }

  public equals(other?: CitationStyleVo | null): boolean {
    if (!other) return false;
    return this._value === other._value;
  }

  public toString(): string {
    return this._value;
  }
}
