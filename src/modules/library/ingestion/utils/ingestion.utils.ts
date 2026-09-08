import { createHash } from 'crypto';

/**
 * Computes SHA-256 hash for ingestion request payload to enable idempotency detection.
 */
export function computeIngestionRequestHash(
  workspaceId: string,
  payload: unknown,
): string {
  return createHash('sha256')
    .update(JSON.stringify({ workspaceId, payload }))
    .digest('hex');
}

/**
 * Sanitizes and trims idempotency keys.
 */
export function sanitizeIdempotencyKey(
  key?: string | null,
): string | undefined {
  if (!key) return undefined;
  const trimmed = key.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
