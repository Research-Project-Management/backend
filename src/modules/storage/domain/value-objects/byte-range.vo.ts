/**
 * Value Object representing an RFC 7233 HTTP Byte Range
 * Formats: "bytes=0-1023", "bytes=500-", "bytes=-500"
 * Validates boundaries and defends against CVE-2011-3192 Range Bombing DoS.
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

  public static parse(rangeHeader: string | undefined, totalSize: number): ByteRange | null {
    if (!rangeHeader || totalSize <= 0) {
      return null;
    }

    // Strict single-range regex — reject multiple overlapping ranges (Range Bombing DoS)
    const match = rangeHeader.trim().match(/^bytes=(\d*)-(\d*)$/);
    if (!match) {
      return null;
    }

    const [_, startStr, endStr] = match;
    let start: number | undefined = startStr ? parseInt(startStr, 10) : undefined;
    let end: number | undefined = endStr ? parseInt(endStr, 10) : undefined;

    // Case 1: Suffix range: bytes=-500 (last 500 bytes)
    if (start === undefined && end !== undefined) {
      start = Math.max(0, totalSize - end);
      end = totalSize - 1;
    }
    // Case 2: Prefix range: bytes=500- (from 500 to end)
    else if (start !== undefined && end === undefined) {
      end = totalSize - 1;
    }
    // Case 3: Start from beginning: bytes=- (full file)
    else if (start === undefined && end === undefined) {
      start = 0;
      end = totalSize - 1;
    }

    if (start === undefined || end === undefined || start < 0 || start >= totalSize || end < start || end >= totalSize) {
      return null;
    }

    return new ByteRange(start, end, totalSize);
  }

  public getContentRangeHeader(): string {
    return `bytes ${this.start}-${this.end}/${this.totalSize}`;
  }
}
