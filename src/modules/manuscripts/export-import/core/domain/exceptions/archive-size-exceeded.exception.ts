/**
 * export-import/core/domain/exceptions/archive-size-exceeded.exception.ts
 * Domain exception thrown when an archive exceeds the maximum uncompressed project size limit.
 */

export class ArchiveSizeExceededException extends Error {
  constructor(sizeBytes: number, maxBytes: number) {
    super(
      `Archive payload exceeds maximum allowed project uncompressed size of ${Math.round(maxBytes / (1024 * 1024))}MB. Found: ${Math.round(sizeBytes / (1024 * 1024))}MB.`,
    );
    this.name = 'ArchiveSizeExceededException';
  }
}
