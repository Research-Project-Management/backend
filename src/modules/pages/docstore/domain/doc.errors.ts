/**
 * modules/manuscripts/docstore/domain/doc.errors.ts
 * Domain errors matching Overleaf Docstore specifications.
 */

import { PagesDomainError } from '@/modules/pages/core/domain/errors';

export class DocNotFoundError extends PagesDomainError {
  constructor(message: string = 'Document not found') {
    super(message, {
      code: 'DOC_NOT_FOUND',
      statusCode: 404,
    });
  }
}

export class DocModifiedError extends PagesDomainError {
  constructor(
    message: string = 'Document has been modified by another process',
    public readonly details?: {
      docId: string;
      rev: number;
      currentRev: number;
    },
  ) {
    super(message, {
      code: 'DOC_VERSION_CONFLICT',
      statusCode: 409,
      details,
    });
  }
}

export class DocTooLargeError extends PagesDomainError {
  constructor(
    public readonly currentSize: number,
    public readonly maxSize: number,
  ) {
    super(
      `Document body length (${currentSize} bytes) exceeds maximum limit (${maxSize} bytes)`,
      {
        code: 'DOC_TOO_LARGE',
        statusCode: 413,
      },
    );
  }
}

export class NullByteDetectedError extends PagesDomainError {
  constructor(
    message: string = 'Null byte (\\u0000) detected in document text',
  ) {
    super(message, {
      code: 'INVALID_DOC_CONTENT',
      statusCode: 400,
    });
  }
}

export class Md5MismatchError extends PagesDomainError {
  constructor(
    message: string = 'MD5 hash mismatch during document transfer',
    public readonly details?: {
      key: string;
      sourceMd5: string;
      actualMd5: string;
    },
  ) {
    super(message, {
      code: 'MD5_MISMATCH',
      statusCode: 400,
      details,
    });
  }
}

export class InvalidSearchPatternError extends PagesDomainError {
  constructor(message: string) {
    super(message, {
      code: 'INVALID_SEARCH_PATTERN',
      statusCode: 400,
    });
  }
}

export class ArchiveObjectNotFoundError extends PagesDomainError {
  constructor(key: string) {
    super(`Archive object not found: ${key}`, {
      code: 'ARCHIVE_OBJECT_NOT_FOUND',
      statusCode: 404,
    });
  }
}

export class ArchiveWriteFailedError extends PagesDomainError {
  constructor(
    public readonly key: string,
    reason: string,
  ) {
    super(`Durable cold-tier archive write failed for "${key}": ${reason}`, {
      code: 'ARCHIVE_WRITE_FAILED',
      statusCode: 503,
      internalReason: reason,
    });
  }
}
