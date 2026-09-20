/**
 * FileHash Value Object.
 * Enforces valid hex representation (e.g. SHA-256 64 chars or MD5 32 chars).
 */
export class FileHashVo {
  private readonly _value: string;

  private static readonly HASH_REGEX = /^[a-fA-F0-9]{32,64}$/;

  private constructor(value: string) {
    this._value = value;
  }

  public static create(rawHash: string | null | undefined): FileHashVo | null {
    if (!rawHash || typeof rawHash !== 'string') {
      return null;
    }
    const cleaned = rawHash.trim().toLowerCase();
    if (!cleaned) return null;

    if (!FileHashVo.HASH_REGEX.test(cleaned)) {
      throw new Error(`Invalid file hash format: "${rawHash}"`);
    }

    return new FileHashVo(cleaned);
  }

  public get value(): string {
    return this._value;
  }

  public equals(other?: FileHashVo | null): boolean {
    if (!other) return false;
    return this._value === other._value;
  }

  public toString(): string {
    return this._value;
  }
}
