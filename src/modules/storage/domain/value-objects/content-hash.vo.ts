import * as crypto from 'crypto';

/**
 * Value Object representing a cryptographic Content Hash (SHA-256)
 * Immutable, self-validating. Used for Content-Addressable Storage (CAS).
 */
export class ContentHash {
  private readonly rawBytes: Buffer;

  private constructor(bytes: Buffer) {
    if (bytes.length !== 32) {
      throw new Error(
        `Invalid SHA-256 hash byte length: expected 32 bytes, got ${bytes.length}`,
      );
    }
    this.rawBytes = Buffer.from(bytes);
  }

  public static fromBuffer(payload: Buffer): ContentHash {
    const hashBytes = crypto.createHash('sha256').update(payload).digest();
    return new ContentHash(hashBytes);
  }

  public static fromHex(hexString: string): ContentHash {
    const sanitized = hexString.trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sanitized)) {
      throw new Error(`Invalid SHA-256 hex string: ${hexString}`);
    }
    return new ContentHash(Buffer.from(sanitized, 'hex'));
  }

  public static fromBytes(bytes: Buffer): ContentHash {
    return new ContentHash(bytes);
  }

  public toHex(): string {
    return this.rawBytes.toString('hex');
  }

  public toBytes(): Buffer {
    return Buffer.from(this.rawBytes);
  }

  public equals(other: ContentHash): boolean {
    return this.rawBytes.equals(other.rawBytes);
  }

  public toString(): string {
    return this.toHex();
  }
}
