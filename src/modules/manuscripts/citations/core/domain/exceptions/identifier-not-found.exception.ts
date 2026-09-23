/**
 * citations/core/domain/exceptions/identifier-not-found.exception.ts
 * Thrown when an academic DOI or arXiv ID cannot be resolved by external catalogs.
 */

export class IdentifierNotFoundException extends Error {
  constructor(public readonly identifier: string) {
    super(`Academic identifier '${identifier}' could not be resolved from CrossRef or arXiv`);
    this.name = 'IdentifierNotFoundException';
    Object.setPrototypeOf(this, IdentifierNotFoundException.prototype);
  }
}
