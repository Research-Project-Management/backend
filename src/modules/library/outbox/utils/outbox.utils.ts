import { createHash } from 'crypto';

/**
 * Generates an idempotent deduplication key for outbox events.
 */
export function generateOutboxDedupeKey(
  workspaceId: string,
  aggregateId: string,
  eventType: string,
  version: number,
): string {
  return `${workspaceId}:${aggregateId}:${eventType}:v${version}`;
}

/**
 * Safely serializes payload into JSON string, handling circular references and BigInt.
 */
export function serializeOutboxPayload(payload: unknown): string {
  return JSON.stringify(payload, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}

/**
 * Computes payload SHA-256 digest to detect duplicate domain events.
 */
export function computePayloadDigest(payload: unknown): string {
  const json = serializeOutboxPayload(payload);
  return createHash('sha256').update(json).digest('hex');
}
