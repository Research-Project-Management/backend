/**
 * filestore/core/domain/exceptions/storage-quota-exceeded.exception.ts
 */

export class StorageQuotaExceededException extends Error {
  constructor(
    public readonly attemptedSizeBytes: number,
    public readonly maxAllowedSizeBytes: number,
  ) {
    super(
      `File size (${attemptedSizeBytes} bytes) exceeds maximum permissible storage limit (${maxAllowedSizeBytes} bytes).`,
    );
    this.name = 'StorageQuotaExceededException';
  }
}
