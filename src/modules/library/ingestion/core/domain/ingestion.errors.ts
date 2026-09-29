import { BaseDomainException } from '../../../shared-kernel/core/errors/domain.exception';

export type IngestionErrorCategory =
  | 'validation_failed'
  | 'unsupported_source'
  | 'metadata_not_found'
  | 'provider_unavailable'
  | 'duplicate_conflict'
  | 'idempotency_conflict'
  | 'storage_failed'
  | 'extraction_failed'
  | 'indexing_failed'
  | 'unauthorized'
  | 'forbidden';

export class IngestionException extends BaseDomainException {
  public readonly category: IngestionErrorCategory;

  constructor(
    message: string,
    category: IngestionErrorCategory = 'validation_failed',
  ) {
    super(message);
    this.category = category;
    this.name = this.constructor.name;
  }
}

export class IngestionValidationException extends IngestionException {
  constructor(message: string) {
    super(message, 'validation_failed');
    this.name = 'IngestionValidationException';
  }
}

export class IngestionUnsupportedSourceException extends IngestionException {
  constructor(source: string) {
    super(`Unsupported ingestion source: ${source}`, 'unsupported_source');
    this.name = 'IngestionUnsupportedSourceException';
  }
}

export class IngestionMetadataNotFoundException extends IngestionException {
  constructor(query: string) {
    super(`Metadata not found for query: ${query}`, 'metadata_not_found');
    this.name = 'IngestionMetadataNotFoundException';
  }
}

export class IngestionIdempotencyConflictException extends IngestionException {
  constructor(
    message = 'Idempotency key reused with mismatched payload or request already in progress',
  ) {
    super(message, 'idempotency_conflict');
    this.name = 'IngestionIdempotencyConflictException';
  }
}

export class IngestionDuplicateConflictException extends IngestionException {
  constructor(message: string) {
    super(message, 'duplicate_conflict');
    this.name = 'IngestionDuplicateConflictException';
  }
}

export class IngestionStorageException extends IngestionException {
  public readonly cause?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'storage_failed');
    this.cause = options?.cause;
    this.name = 'IngestionStorageException';
  }
}

export class IngestionRateLimitException extends IngestionException {
  constructor(
    message = 'Upstream provider rate limit exceeded, please retry later',
  ) {
    super(message, 'provider_unavailable');
    this.name = 'IngestionRateLimitException';
  }
}
