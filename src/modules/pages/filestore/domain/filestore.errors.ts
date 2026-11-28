/**
 * modules/pages/filestore/domain/filestore.errors.ts
 * Domain exceptions and size limits for Pages Filestore.
 */

import { PagesDomainError } from '@/modules/pages/core/domain/errors';

export const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB (Overleaf Parity)

// ============================================================================
// EXCEPTIONS
// ============================================================================

export class FileNotFoundException extends PagesDomainError {
  constructor(
    public readonly fileId: string,
    public readonly projectId?: string,
  ) {
    super(
      `Binary asset '${fileId}' was not found in space '${projectId ?? 'unknown'}'.`,
      {
        code: 'FILE_NOT_FOUND',
        statusCode: 404,
      },
    );
  }
}

export class InvalidByteRangeException extends PagesDomainError {
  constructor(
    public readonly rangeHeader: string,
    public readonly totalSizeBytes: number,
    message?: string,
  ) {
    super(
      message ??
        `Requested byte range '${rangeHeader}' is unsatisfiable for object of size ${totalSizeBytes} bytes (RFC 7233).`,
      {
        code: 'INVALID_BYTE_RANGE',
        statusCode: 416,
      },
    );
  }
}

export class DuplicateFileException extends PagesDomainError {
  constructor(
    public readonly filename: string,
    public readonly projectId: string,
  ) {
    super(
      `A binary asset or node at '${filename}' already exists in space '${projectId}'.`,
      {
        code: 'DUPLICATE_FILE',
        statusCode: 409,
      },
    );
  }
}

export class StorageQuotaExceededException extends PagesDomainError {
  constructor(
    public readonly attemptedSizeBytes: number,
    public readonly maxAllowedSizeBytes: number,
  ) {
    super(
      `File size (${attemptedSizeBytes} bytes) exceeds maximum permissible storage limit (${maxAllowedSizeBytes} bytes).`,
      {
        code: 'STORAGE_QUOTA_EXCEEDED',
        statusCode: 413,
      },
    );
  }
}

export class FilestoreValidationException extends PagesDomainError {
  constructor(message: string) {
    super(message, {
      code: 'FILESTORE_VALIDATION_ERROR',
      statusCode: 400,
    });
  }
}

