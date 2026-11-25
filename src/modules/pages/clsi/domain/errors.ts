/**
 * modules/pages/clsi/domain/errors.ts
 * Pure Domain: Per-(spaceId, userId) Compile Lock & Concurrency Cap Domain Errors for LaTeX compilation.
 * 100% Pure TypeScript, zero framework dependencies.
 */

import { PagesDomainError } from '@/modules/pages/core/domain/pages-domain.error';

/**
 * Citation: Overleaf `services/clsi/app/js/LockManager.js` (lines 21-33) &
 * `services/clsi/app/js/CompileController.js` (lines 77-80).
 * Thrown when a compile lock is already active for the target `(spaceId, userId)`
 * (`HTTP 423 Locked`, `status: 'compile-in-progress'`), rejecting overlapping compile
 * requests immediately without killing the in-flight compilation.
 */
export class AlreadyCompilingError extends PagesDomainError {
  public readonly status = 'compile-in-progress';

  constructor(message = 'compile in progress') {
    super(message, {
      code: 'COMPILE_IN_PROGRESS',
      statusCode: 423,
    });
  }
}

/**
 * Citation: Overleaf `services/clsi/app/js/Errors.js` (line 34),
 * `services/clsi/app/js/LockManager.js` (lines 39-51), &
 * `services/clsi/app/js/CompileController.js` (lines 97-101).
 * Thrown immediately (fail-fast, 0ms waiting queue) when active concurrent compiles
 * (`LOCKS.size`) reach `compileConcurrencyLimit` or exhaust live memory headroom,
 * returning HTTP 503 Unavailable (`status: 'unavailable'`).
 */
export class TooManyCompileRequestsError extends PagesDomainError {
  public readonly status = 'unavailable';

  constructor(message = 'too many concurrent compile requests') {
    super(message, {
      code: 'TOO_MANY_COMPILE_REQUESTS',
      statusCode: 503,
    });
  }
}

export class CompileRateLimitExceededError extends PagesDomainError {
  constructor(public readonly maxPerMinute: number) {
    super(
      `Compilation rate limit exceeded (${maxPerMinute} runs/min). Please wait a moment before recompiling.`,
      {
        code: 'COMPILE_RATE_LIMITED',
        statusCode: 429,
      },
    );
  }
}

export class AutoCompileShedError extends PagesDomainError {
  public readonly status = 'autocompile-backoff';

  constructor(
    public readonly active: number,
    public readonly threshold: number,
  ) {
    super(
      'Auto-compilation shed under high concurrency load to prioritize manual builds',
      {
        code: 'AUTO_COMPILE_SHED',
        statusCode: 429,
      },
    );
  }
}

export class CompileSupersededError extends PagesDomainError {
  constructor(message = 'Compilation superseded by a newer request') {
    super(message, {
      code: 'COMPILE_SUPERSEDED',
      statusCode: 409,
    });
  }
}

export class CompileAbortedError extends PagesDomainError {
  constructor() {
    super('Compilation aborted', {
      code: 'COMPILE_ABORTED',
      statusCode: 499,
    });
  }
}

export type CompilePriority = 'manual' | 'auto';

export interface CompileLockStats {
  capacity: number;
  active: number;
  inFlightProjects: number;
}

/**
 * modules/pages/clsi/domain/errors.ts
 * Typed domain errors for CLSI compilation sandbox isolation.
 * User-facing messages are strictly sanitized to prevent host path and environment leakage.
 */


export class SandboxUnavailableException extends PagesDomainError {
  constructor(
    message: string = 'Compilation is temporarily unavailable.',
    internalReason?: string,
  ) {
    super(message, {
      code: 'SANDBOX_UNAVAILABLE',
      statusCode: 503,
      internalReason,
    });
  }
}

export class SandboxConfigurationException extends PagesDomainError {
  constructor(
    message: string = 'CLSI Sandbox configuration is invalid.',
    internalReason?: string,
  ) {
    super(message, {
      code: 'SANDBOX_CONFIG_INVALID',
      statusCode: 500,
      internalReason,
    });
  }
}

export class SandboxPolicyViolationException extends PagesDomainError {
  constructor(
    message: string = 'Compilation could not be started.',
    internalReason?: string,
  ) {
    super(message, {
      code: 'SANDBOX_POLICY_VIOLATION',
      statusCode: 500,
      internalReason,
    });
  }
}

export class UnsafePathException extends PagesDomainError {
  constructor(message: string = 'Invalid file path.', internalReason?: string) {
    super(message, {
      code: 'UNSAFE_PATH',
      statusCode: 400,
      internalReason,
    });
  }
}

export class RemoteClsiClientError extends PagesDomainError {
  constructor(
    message: string,
    statusCode: number,
    code = 'REMOTE_CLSI_CLIENT_ERROR',
    details?: unknown,
  ) {
    super(message, {
      code,
      statusCode,
      details,
    });
  }
}
