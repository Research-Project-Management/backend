/**
 * modules/manuscripts/docstore/domain/doc.errors.ts
 * Domain errors matching Overleaf Docstore specifications.
 */

export class DocNotFoundError extends Error {
  public readonly statusCode = 404;
  public readonly code = 'DOC_NOT_FOUND';

  constructor(message: string = 'Document not found') {
    super(message);
    this.name = 'DocNotFoundError';
  }
}

export class DocModifiedError extends Error {
  public readonly statusCode = 409;
  public readonly code = 'DOC_VERSION_CONFLICT';

  constructor(
    message: string = 'Document has been modified by another process',
    public readonly details?: {
      docId: string;
      rev: number;
      currentRev: number;
    },
  ) {
    super(message);
    this.name = 'DocModifiedError';
  }
}

export class DocTooLargeError extends Error {
  public readonly statusCode = 413;
  public readonly code = 'DOC_TOO_LARGE';

  constructor(
    public readonly currentSize: number,
    public readonly maxSize: number,
  ) {
    super(
      `Document body length (${currentSize} bytes) exceeds maximum limit (${maxSize} bytes)`,
    );
    this.name = 'DocTooLargeError';
  }
}

export class NullByteDetectedError extends Error {
  public readonly statusCode = 400;
  public readonly code = 'INVALID_DOC_CONTENT';

  constructor(
    message: string = 'Null byte (\\u0000) detected in document text',
  ) {
    super(message);
    this.name = 'NullByteDetectedError';
  }
}

export class Md5MismatchError extends Error {
  public readonly statusCode = 400;
  public readonly code = 'MD5_MISMATCH';

  constructor(
    message: string = 'MD5 hash mismatch during document transfer',
    public readonly details?: {
      key: string;
      sourceMd5: string;
      actualMd5: string;
    },
  ) {
    super(message);
    this.name = 'Md5MismatchError';
  }
}

export class InvalidSearchPatternError extends Error {
  public readonly statusCode = 400;
  public readonly code = 'INVALID_SEARCH_PATTERN';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidSearchPatternError';
  }
}

export class ArchiveObjectNotFoundError extends Error {
  public readonly statusCode = 404;
  public readonly code = 'ARCHIVE_OBJECT_NOT_FOUND';

  constructor(key: string) {
    super(`Archive object not found: ${key}`);
    this.name = 'ArchiveObjectNotFoundError';
  }
}
