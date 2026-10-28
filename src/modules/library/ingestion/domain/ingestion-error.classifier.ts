import { BadRequestException } from '@nestjs/common';
import { IngestionSubmissionEnvelope } from '@/modules/library/ingestion/types/submission.types';

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
