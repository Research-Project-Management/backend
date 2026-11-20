/**
 * modules/manuscripts/clsi/domain/sandbox.errors.ts
 * Typed domain errors for CLSI compilation sandbox isolation.
 * User-facing messages are strictly sanitized to prevent host path and environment leakage.
 */

import { PagesDomainError } from '@/modules/pages/core/domain/pages-domain.error';

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

export class ClsiQueueUnavailableError extends PagesDomainError {
  constructor(message: string = 'CLSI compile queue is not initialized') {
    super(message, {
      code: 'CLSI_QUEUE_UNAVAILABLE',
      statusCode: 503,
    });
  }
}

export class ClsiWorkerExecutionError extends PagesDomainError {
  public readonly isWorkerExecutionError = true;

  constructor(
    message: string = 'Job execution failed in CLSI worker',
    statusCode = 503,
    code = 'CLSI_WORKER_FAILED',
  ) {
    super(message, {
      code,
      statusCode,
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
