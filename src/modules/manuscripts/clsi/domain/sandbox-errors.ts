/**
 * modules/manuscripts/clsi/domain/sandbox-errors.ts
 * Typed domain errors for CLSI compilation sandbox isolation.
 * User-facing messages are strictly sanitized to prevent host path and environment leakage.
 */

export class SandboxUnavailableException extends Error {
  public readonly code = 'SANDBOX_UNAVAILABLE';
  public readonly httpStatus = 503;

  constructor(
    message: string = 'Compilation is temporarily unavailable.',
    public readonly internalReason?: string,
  ) {
    super(message);
    this.name = 'SandboxUnavailableException';
  }
}

export class SandboxConfigurationException extends Error {
  public readonly code = 'SANDBOX_CONFIG_INVALID';

  constructor(
    message: string = 'CLSI Sandbox configuration is invalid.',
    public readonly internalReason?: string,
  ) {
    super(message);
    this.name = 'SandboxConfigurationException';
  }
}

export class SandboxPolicyViolationException extends Error {
  public readonly code = 'SANDBOX_POLICY_VIOLATION';
  public readonly httpStatus = 500;

  constructor(
    message: string = 'Compilation could not be started.',
    public readonly internalReason?: string,
  ) {
    super(message);
    this.name = 'SandboxPolicyViolationException';
  }
}

export class UnsafePathException extends Error {
  public readonly code = 'UNSAFE_PATH';
  public readonly httpStatus = 400;

  constructor(
    message: string = 'Invalid file path.',
    public readonly internalReason?: string,
  ) {
    super(message);
    this.name = 'UnsafePathException';
  }
}
