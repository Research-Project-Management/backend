/**
 * MimeType Value Object.
 * Validates canonical MIME type syntax (type/subtype).
 */
export class MimeTypeVo {
  private readonly _value: string;

  private static readonly MIME_REGEX =
    /^[a-zA-Z0-9]+(?:\.[a-zA-Z0-9]+)*\/[a-zA-Z0-9+.-]+$/;

  private constructor(value: string) {
    this._value = value;
  }

  public static create(rawMime: string | null | undefined): MimeTypeVo {
    if (!rawMime || typeof rawMime !== 'string') {
      return new MimeTypeVo('application/pdf'); // Default fallback
    }
    const cleaned = rawMime.trim().toLowerCase();
    if (!cleaned) {
      return new MimeTypeVo('application/pdf');
    }

    if (!MimeTypeVo.MIME_REGEX.test(cleaned)) {
      throw new Error(`Invalid MIME type format: "${rawMime}"`);
    }

    return new MimeTypeVo(cleaned);
  }

  public get value(): string {
    return this._value;
  }

  public get isPdf(): boolean {
    return this._value === 'application/pdf';
  }

  public equals(other?: MimeTypeVo | null): boolean {
    if (!other) return false;
    return this._value === other._value;
  }

  public toString(): string {
    return this._value;
  }
}
