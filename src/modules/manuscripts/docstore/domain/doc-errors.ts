/**
 * modules/manuscripts/docstore/domain/doc-errors.ts
 * Domain errors matching Overleaf Docstore specifications.
 */

export class DocNotFoundError extends Error {
  constructor(message: string = 'Document not found') {
    super(message);
    this.name = 'DocNotFoundError';
  }
}

export class DocModifiedError extends Error {
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
  constructor(
    message: string = 'Null byte (\\u0000) detected in document text',
  ) {
    super(message);
    this.name = 'NullByteDetectedError';
  }
}

export class Md5MismatchError extends Error {
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
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSearchPatternError';
  }
}

export class ArchiveObjectNotFoundError extends Error {
  constructor(key: string) {
    super(`Archive object not found: ${key}`);
    this.name = 'ArchiveObjectNotFoundError';
  }
}
