/**
 * diagnostics/core/domain/exceptions/explanation-not-found.exception.ts
 * Thrown when an explanation for a requested error code cannot be found in the knowledge base.
 */

export class ExplanationNotFoundException extends Error {
  constructor(public readonly errorCode: string) {
    super(`No explanation found in knowledge base for error code: '${errorCode}'`);
    this.name = 'ExplanationNotFoundException';
    Object.setPrototypeOf(this, ExplanationNotFoundException.prototype);
  }
}
