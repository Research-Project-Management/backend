import { BadRequestException } from '@nestjs/common';

/**
 * Standard RFC 4122 Nil UUID (00000000-0000-0000-0000-000000000000).
 */
export const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * Canonical RFC 4122 UUID pattern matching standard 8-4-4-4-12 hex format.
 */
const UUID_FORMAT_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Type guard validating whether a value is a valid canonical RFC 4122 UUID string.
 */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_FORMAT_REGEX.test(value);
}

/**
 * Normalizes a UUID string by trimming whitespace and converting to lowercase.
 * Returns `null` if the input is not a valid UUID.
 */
export function normalizeUuid(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return UUID_FORMAT_REGEX.test(trimmed) ? trimmed : null;
}

/**
 * Asserts that a value is a valid UUID, throwing a BadRequestException if invalid.
 */
export function assertUuid(
  value: unknown,
  fieldName = 'Identifier',
): asserts value is string {
  if (!isUuid(value)) {
    throw new BadRequestException(
      `${fieldName} must be a valid canonical UUID`,
    );
  }
}
