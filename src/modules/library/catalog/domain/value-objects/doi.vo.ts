/**
 * DOI (Digital Object Identifier) Value Object.
 * Enforces validation and canonical lowercase normalization (e.g., 10.1000/182).
 */
export class DoiVo {
  private readonly _value: string;

  private static readonly DOI_REGEX = /^10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+$/;

  private constructor(value: string) {
    this._value = value;
  }

  public static create(rawDoi: string | null | undefined): DoiVo | null {
    if (!rawDoi || typeof rawDoi !== 'string') {
      return null;
    }

    // Clean leading/trailing spaces and URI prefixes
    let cleaned = rawDoi.trim();
    cleaned = cleaned.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
    cleaned = cleaned.replace(/^doi:\s*/i, '');
    cleaned = cleaned.trim();

    if (!cleaned) {
      return null;
    }

    if (!DoiVo.DOI_REGEX.test(cleaned)) {
      throw new Error(`Invalid DOI format: "${rawDoi}"`);
    }

    return new DoiVo(cleaned.toLowerCase());
  }

  public get value(): string {
    return this._value;
  }

  public equals(other?: DoiVo | null): boolean {
    if (!other) return false;
    return this._value === other._value;
  }

  public toString(): string {
    return this._value;
  }
}
