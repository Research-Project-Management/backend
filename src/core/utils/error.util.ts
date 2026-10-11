/**
 * Safely extracts a readable error message from an unknown error value.
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object' && 'message' in error) {
    return String(error.message);
  }
  return 'An unexpected error occurred';
}

/**
 * Exhaustiveness check helper for discriminated unions and enums.
 * Triggers a TypeScript compile-time error if any branch remains unhandled.
 */
export function assertNever(
  value: never,
  message = `Unhandled discriminated union member: ${JSON.stringify(value)}`,
): never {
  throw new Error(message);
}

/**
 * Result type representing either a successful value or an error.
 */
export type Result<T, E = Error> =
  | { ok: true; value: T; error?: never }
  | { ok: false; error: E; value?: never };

export const Ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const Err = <E>(error: E): Result<never, E> => ({ ok: false, error });

/**
 * Safely executes a synchronous function and returns a Result<T, E>
 */
export function tryCatchSync<T, E = Error>(fn: () => T): Result<T, E> {
  try {
    return Ok(fn());
  } catch (error) {
    return Err(error as E);
  }
}

/**
 * Safely awaits an asynchronous Promise and returns a Result<T, E>
 */
export async function tryCatch<T, E = Error>(
  promise: Promise<T>,
): Promise<Result<T, E>> {
  try {
    const value = await promise;
    return Ok(value);
  } catch (error) {
    return Err(error as E);
  }
}
