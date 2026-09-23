/**
 * filestore/core/domain/exceptions/invalid-byte-range.exception.ts
 */

export class InvalidByteRangeException extends Error {
  constructor(
    public readonly rangeHeader: string,
    public readonly totalSizeBytes: number,
    message?: string,
  ) {
    super(
      message ??
        `Requested byte range '${rangeHeader}' is unsatisfiable for object of size ${totalSizeBytes} bytes (RFC 7233).`,
    );
    this.name = 'InvalidByteRangeException';
  }
}
