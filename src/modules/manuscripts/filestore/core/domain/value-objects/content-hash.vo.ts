/**
 * filestore/core/domain/value-objects/content-hash.vo.ts
 * Value Object for Content-Addressable Storage (CAS) hashes (SHA-1 / SHA-256).
 */

export class ContentHash {
  private readonly _value: string;

  private constructor(value: string) {
    this._value = value.toLowerCase().trim();
  }

  public static create(hash: string): ContentHash {
    if (!hash || typeof hash !== 'string') {
      throw new Error('Content hash must be a non-empty string.');
    }

    const trimmed = hash.trim().toLowerCase();
    // Support standard SHA-1 (40 hex chars) or SHA-256 (64 hex chars)
    if (!/^[0-9a-f]{40}$/.test(trimmed) && !/^[0-9a-f]{64}$/.test(trimmed)) {
      throw new Error(`Invalid content hash format: '${hash}'. Expected 40-char or 64-char hex string.`);
    }

    return new ContentHash(trimmed);
  }

  public getValue(): string {
    return this._value;
  }

  public equals(other: ContentHash): boolean {
    return this._value === other._value;
  }

  public toString(): string {
    return this._value;
  }
}
