/**
 * filestore/core/domain/value-objects/byte-range.vo.ts
 * Value Object encapsulating RFC 7233 HTTP Byte Range validation and calculations.
 */

import { InvalidByteRangeException } from '../exceptions/invalid-byte-range.exception';

export class ByteRange {
  public readonly start: number;
  public readonly end: number;
  public readonly totalSizeBytes: number;

  private constructor(start: number, end: number, totalSizeBytes: number) {
    this.start = start;
    this.end = end;
    this.totalSizeBytes = totalSizeBytes;
  }

  /**
   * Parses an RFC 7233 Range header string (e.g. "bytes=0-1023", "bytes=500-", "bytes=-200").
   * Returns null if no range header is supplied.
   * Throws InvalidByteRangeException if range is syntactically invalid or unsatisfiable.
   */
  public static parse(rangeHeader: string | undefined | null, totalSizeBytes: number): ByteRange | null {
    if (!rangeHeader || typeof rangeHeader !== 'string' || !rangeHeader.trim()) {
      return null;
    }

    const trimmed = rangeHeader.trim();
    if (!trimmed.startsWith('bytes=')) {
      throw new InvalidByteRangeException(rangeHeader, totalSizeBytes, 'Range header must start with "bytes="');
    }

    const rangePart = trimmed.slice(6).trim();
    // Only single-part range is supported for streaming
    if (rangePart.includes(',')) {
      // Multipart ranges are not supported; fallback or pick first
      const firstRange = rangePart.split(',')[0].trim();
      return ByteRange.parseSingleRange(firstRange, totalSizeBytes, rangeHeader);
    }

    return ByteRange.parseSingleRange(rangePart, totalSizeBytes, rangeHeader);
  }

  private static parseSingleRange(rangeStr: string, totalSizeBytes: number, originalHeader: string): ByteRange {
    const parts = rangeStr.split('-');
    if (parts.length !== 2) {
      throw new InvalidByteRangeException(originalHeader, totalSizeBytes, 'Invalid range format');
    }

    let start: number;
    let end: number;

    const startStr = parts[0].trim();
    const endStr = parts[1].trim();

    if (startStr === '' && endStr === '') {
      throw new InvalidByteRangeException(originalHeader, totalSizeBytes, 'Range cannot be empty');
    }

    if (startStr === '') {
      // Suffix byte range: e.g. "-500" means final 500 bytes
      const suffixLength = parseInt(endStr, 10);
      if (isNaN(suffixLength) || suffixLength <= 0) {
        throw new InvalidByteRangeException(originalHeader, totalSizeBytes, 'Invalid suffix range length');
      }
      start = Math.max(0, totalSizeBytes - suffixLength);
      end = totalSizeBytes - 1;
    } else if (endStr === '') {
      // Open-ended range: e.g. "500-" means byte 500 to end
      start = parseInt(startStr, 10);
      if (isNaN(start) || start < 0) {
        throw new InvalidByteRangeException(originalHeader, totalSizeBytes, 'Invalid start byte');
      }
      end = totalSizeBytes - 1;
    } else {
      // Explicit range: e.g. "0-499"
      start = parseInt(startStr, 10);
      end = parseInt(endStr, 10);
      if (isNaN(start) || isNaN(end) || start < 0 || end < 0) {
        throw new InvalidByteRangeException(originalHeader, totalSizeBytes, 'Range offsets must be non-negative integers');
      }
    }

    // Validation against total length
    if (totalSizeBytes === 0) {
      throw new InvalidByteRangeException(originalHeader, totalSizeBytes, 'Cannot request range on 0-byte file');
    }

    if (start > end || start >= totalSizeBytes) {
      throw new InvalidByteRangeException(originalHeader, totalSizeBytes);
    }

    // Clamp end if larger than totalSizeBytes
    end = Math.min(end, totalSizeBytes - 1);

    return new ByteRange(start, end, totalSizeBytes);
  }

  public get contentLength(): number {
    return this.end - this.start + 1;
  }

  public toContentRangeHeader(): string {
    return `bytes ${this.start}-${this.end}/${this.totalSizeBytes}`;
  }
}
