/**
 * export-import/core/domain/exceptions/invalid-zip-archive.exception.ts
 * Domain exception thrown when an uploaded ZIP file is malformed, corrupted, or empty.
 */

export class InvalidZipArchiveException extends Error {
  constructor(message = 'The provided archive is not a valid ZIP file or contains no usable entries.') {
    super(message);
    this.name = 'InvalidZipArchiveException';
  }
}
