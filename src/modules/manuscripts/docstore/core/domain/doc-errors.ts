/**
 * modules/manuscripts/docstore/core/domain/doc-errors.ts
 * Domain errors matching Overleaf Docstore specifications.
 */

export class DocNotFoundError extends Error {
  constructor(message: string = 'Document not found') {
    super(message);
    this.name = 'DocNotFoundError';
  }
}

/**
 * Thrown when an Optimistic Concurrency Control (OCC) collision occurs.
 * Matches Overleaf DocModifiedError (409 Conflict).
 */
export class DocModifiedError extends Error {
  constructor(
    message: string = 'Document has been modified by another process',
    public readonly details?: {
      docId: string;
      rev: number;
      currentRev: number;
    }
  ) {
    super(message);
    this.name = 'DocModifiedError';
  }
}

/**
 * Thrown when a document exceeds the maximum allowable text size (default: 2MB).
 * Matches Overleaf HTTP 413 Payload Too Large.
 */
export class DocTooLargeError extends Error {
  constructor(
    public readonly currentSize: number,
    public readonly maxSize: number
  ) {
    super(
      `Document body length (${currentSize} bytes) exceeds maximum limit (${maxSize} bytes)`
    );
    this.name = 'DocTooLargeError';
  }
}

/**
 * Thrown when null bytes (\u0000) are detected in string content,
 * preventing memory corruption and C-string truncation in databases/filesystems.
 */
export class NullByteDetectedError extends Error {
  constructor(message: string = 'Null byte (\\u0000) detected in document text') {
    super(message);
    this.name = 'NullByteDetectedError';
  }
}

/**
 * Thrown when downloaded stream MD5 does not match expected header hash.
 * Matches Overleaf Md5MismatchError.
 */
export class Md5MismatchError extends Error {
  constructor(
    message: string = 'MD5 hash mismatch during document transfer',
    public readonly details?: {
      key: string;
      sourceMd5: string;
      actualMd5: string;
    }
  ) {
    super(message);
    this.name = 'Md5MismatchError';
  }
}
