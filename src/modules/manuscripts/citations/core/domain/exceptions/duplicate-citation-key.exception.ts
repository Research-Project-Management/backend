/**
 * citations/core/domain/exceptions/duplicate-citation-key.exception.ts
 * Thrown when duplicate citation keys are discovered across the project's .bib files.
 */

export class DuplicateCitationKeyException extends Error {
  constructor(public readonly key: string, public readonly files: string[]) {
    super(`Duplicate citation key '${key}' detected across files: ${files.join(', ')}`);
    this.name = 'DuplicateCitationKeyException';
    Object.setPrototypeOf(this, DuplicateCitationKeyException.prototype);
  }
}
