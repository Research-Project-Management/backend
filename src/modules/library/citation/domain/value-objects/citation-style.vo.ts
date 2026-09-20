export type SupportedCitationStyle =
  'apa' | 'harvard' | 'vancouver' | 'ieee' | 'chicago' | 'nature' | 'science';

/**
 * CitationStyle Value Object validating academic citation styles.
 */
export class CitationStyleVo {
  private readonly _value: SupportedCitationStyle;

  private static readonly SUPPORTED: Set<string> = new Set([
    'apa',
    'harvard',
    'vancouver',
    'ieee',
    'chicago',
    'nature',
    'science',
  ]);

  private constructor(value: SupportedCitationStyle) {
    this._value = value;
  }

  public static create(rawStyle?: string | null): CitationStyleVo {
    if (!rawStyle) return new CitationStyleVo('apa');
    const cleaned = rawStyle.trim().toLowerCase();
    if (!CitationStyleVo.SUPPORTED.has(cleaned)) {
      // Default to apa if unsupported style requested
      return new CitationStyleVo('apa');
    }
    return new CitationStyleVo(cleaned as SupportedCitationStyle);
  }

  public get value(): SupportedCitationStyle {
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
