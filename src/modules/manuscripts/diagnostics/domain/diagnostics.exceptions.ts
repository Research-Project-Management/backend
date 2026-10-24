/**
 * diagnostics/core/domain/exceptions/explanation-not-found.exception.ts
 * Thrown when an explanation for a requested error code cannot be found in the knowledge base.
 */

export class ExplanationNotFoundException extends Error {
  constructor(public readonly errorCode: string) {
    super(
      `No explanation found in knowledge base for error code: '${errorCode}'`,
    );
    this.name = 'ExplanationNotFoundException';
    Object.setPrototypeOf(this, ExplanationNotFoundException.prototype);
  }
}

/**
 * diagnostics/core/domain/exceptions/invalid-log-format.exception.ts
 * Thrown when raw log content is empty or unparsable.
 */

export class InvalidLogFormatException extends Error {
  constructor(message = 'The provided compilation log is empty or invalid') {
    super(message);
    this.name = 'InvalidLogFormatException';
    Object.setPrototypeOf(this, InvalidLogFormatException.prototype);
  }
}
