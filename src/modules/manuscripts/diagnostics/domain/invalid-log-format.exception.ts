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
