import * as crypto from 'crypto';

/**
 * Cryptographic Content Hash (SHA-256) for Content-Addressable Storage (CAS).
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

/**
 * Deterministic, sanitized Storage Keys using CAS hierarchy to prevent S3 partition hotspots.
 */
export class StorageKey {
  private readonly rawKey: string;

  private constructor(key: string) {
    this.rawKey = key;
  }

  public static forBlob(sha256Hex: string): StorageKey {
    const cleanHex = sha256Hex.trim().toLowerCase();
    const p1 = cleanHex.slice(0, 2);
    const p2 = cleanHex.slice(2, 4);
    return new StorageKey(`blobs/${p1}/${p2}/${cleanHex}`);
  }

  public static forUnhashedBlob(blobId: string): StorageKey {
    const cleanId = blobId.trim().replace(/[^a-zA-Z0-9-]/g, '');
    const p1 = cleanId.slice(0, 2) || '00';
    return new StorageKey(`blobs/raw/${p1}/${cleanId}`);
  }

  public static forDerivative(
    sha256Hex: string,
    variant = 'thumb',
  ): StorageKey {
    const cleanHex = sha256Hex.trim().toLowerCase();
    const p1 = cleanHex.slice(0, 2);
    const p2 = cleanHex.slice(2, 4);
    const safeVariant = variant.replace(/[^a-zA-Z0-9_-]/g, '') || 'thumb';
    return new StorageKey(
      `derivatives/${p1}/${p2}/${cleanHex}/${safeVariant}.webp`,
    );
  }

  public static forStaging(
    userId: string,
    fileUuid: string,
    ext: string,
  ): StorageKey {
    const safeExt = (ext || 'bin').replace(/[^a-zA-Z0-9]/g, '') || 'bin';
    return new StorageKey(`uploads/staging/${userId}/${fileUuid}.${safeExt}`);
  }

  public static forMultipartStaging(
    sessionId: string,
    ext: string,
  ): StorageKey {
    const safeExt = (ext || 'bin').replace(/[^a-zA-Z0-9]/g, '') || 'bin';
    return new StorageKey(
      `uploads/staging/multipart/${sessionId}/payload.${safeExt}`,
    );
  }

  public static fromString(key: string): StorageKey {
    const sanitized = key.replace(/\0/g, '').replace(/(\.\.[/\\])+/g, '');
    return new StorageKey(sanitized);
  }

  public value(): string {
    return this.rawKey;
  }

  public toString(): string {
    return this.rawKey;
  }
}

export enum BlobStatus {
  PENDING = 'PENDING',
  READY = 'READY',
  DELETED = 'DELETED',
}

/**
 * RFC 7233 HTTP Byte Range ("bytes=0-1023", "bytes=500-", "bytes=-500").
 */
export class ByteRange {
  public readonly start: number;
  public readonly end: number;
  public readonly length: number;
  public readonly totalSize: number;

  private constructor(start: number, end: number, totalSize: number) {
    this.start = start;
    this.end = end;
    this.length = end - start + 1;
    this.totalSize = totalSize;
  }

  public static parse(
    rangeHeader: string | undefined,
    totalSize: number,
  ): ByteRange | null {
    if (!rangeHeader || totalSize <= 0) {
      return null;
    }

    const match = rangeHeader.trim().match(/^bytes=(\d*)-(\d*)$/);
    if (!match) {
      return null;
    }

    const [, startStr, endStr] = match;
    let start: number | undefined = startStr
      ? parseInt(startStr, 10)
      : undefined;
    let end: number | undefined = endStr ? parseInt(endStr, 10) : undefined;

    if (start === undefined && end !== undefined) {
      start = Math.max(0, totalSize - end);
      end = totalSize - 1;
    } else if (start !== undefined && end === undefined) {
      end = totalSize - 1;
    } else if (start === undefined && end === undefined) {
      start = 0;
      end = totalSize - 1;
    }

    if (
      start === undefined ||
      end === undefined ||
      start < 0 ||
      start >= totalSize ||
      end < start ||
      end >= totalSize
    ) {
      return null;
    }

    return new ByteRange(start, end, totalSize);
  }

  public getContentRangeHeader(): string {
    return `bytes ${this.start}-${this.end}/${this.totalSize}`;
  }
}
