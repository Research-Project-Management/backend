/**
 * export-import/core/domain/exceptions/zip-slip-security.exception.ts
 * Domain exception thrown when a ZIP entry attempts directory traversal (Zip Slip attack).
 */

export class ZipSlipSecurityException extends Error {
  constructor(entryPath: string) {
    super(`Security Violation: Zip entry '${entryPath}' contains illegal path traversal sequences.`);
    this.name = 'ZipSlipSecurityException';
  }
}
