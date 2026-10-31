import { BadRequestException } from '@nestjs/common';
import { BaseDomainException } from '@/modules/library/core/errors/domain.exception';
import { IngestionSubmissionEnvelope } from './ingestion.types';

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

export interface PipelineErrorClassificationDelegate {
  isNonRetryableError?: (err: unknown) => boolean;
  isRetryableError?: (err: unknown) => boolean;
}

const NON_RETRYABLE_MESSAGE_PATTERN =
  /no valid bibliographic metadata|invalid.*payload|validation failed|bad request|malformed|unsupported format/i;

const RETRYABLE_ERROR_PATTERN =
  /(?:etimedout|econnreset|econnrefused|eai_again|enotfound|epipe|timeout|timed out|rate[\s_-]*limit|too many requests|429|502|503|504|deadlock|serialization failure|connection[\s_-]*(?:lost|reset|refused|closed|error)|temporarily unavailable|service unavailable|bad gateway|gateway timeout|network error|socket hang up|slowdown)/i;

/**
 * Determines whether an ingestion error is permanently non-retryable
 * (e.g., 4xx validation error, empty/malformed bibliographic metadata).
 */
export function isNonRetryableIngestionError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  if (err instanceof BadRequestException) return true;
  const errObj = err as Record<string, unknown>;
  if (errObj.retryable === false) return true;
  const status = (errObj.status ?? errObj.statusCode) as number | undefined;
  if (
    status === 400 ||
    status === 401 ||
    status === 403 ||
    status === 404 ||
    status === 422
  ) {
    return true;
  }
  const combined = `${String(errObj.code || '')} ${String(errObj.message || '')}`;
  return NON_RETRYABLE_MESSAGE_PATTERN.test(combined);
}

/**
 * Determines whether an ingestion error is transient/retryable (e.g., network
 * timeout, rate limit, 5xx upstream failure, transient DB connection drop).
 */
export function isRetryableIngestionError(
  err: unknown,
  envelope?: Pick<IngestionSubmissionEnvelope, 'isFinalAttempt'>,
  delegate?: PipelineErrorClassificationDelegate,
): boolean {
  const explicitFinal = envelope?.isFinalAttempt;
  if (explicitFinal === true) return false;
  if (typeof delegate?.isNonRetryableError === 'function') {
    if (delegate.isNonRetryableError(err)) return false;
  } else if (isNonRetryableIngestionError(err)) {
    return false;
  }

  if (explicitFinal === false) return true;
  if (typeof delegate?.isRetryableError === 'function') {
    return delegate.isRetryableError(err);
  }

  if (!err || typeof err !== 'object') return false;
  const errObj = err as Record<string, unknown>;
  if (typeof errObj.retryable === 'boolean') return errObj.retryable;

  const status = (errObj.status ?? errObj.statusCode) as number | undefined;
  if (
    status === 408 ||
    status === 429 ||
    (typeof status === 'number' && status >= 500 && status < 600)
  ) {
    return true;
  }

  const combined = `${String(errObj.code || '')} ${String(errObj.message || '')}`;
  return RETRYABLE_ERROR_PATTERN.test(combined);
}
