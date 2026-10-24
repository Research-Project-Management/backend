/**
 * citations/domain/exceptions/identifier-not-found.exception.ts
 * Thrown when an academic DOI or arXiv ID cannot be resolved by external catalogs.
 */

export class IdentifierNotFoundException extends Error {
  constructor(public readonly identifier: string) {
    super(
      `Academic identifier '${identifier}' could not be resolved from CrossRef or arXiv`,
    );
    this.name = 'IdentifierNotFoundException';
    Object.setPrototypeOf(this, IdentifierNotFoundException.prototype);
  }
}

/**
 * citations/domain/exceptions/invalid-bibtex.exception.ts
 * Thrown when raw BibTeX text has syntax errors or malformed structure.
 */

export class InvalidBibtexException extends Error {
  constructor(
    message = 'The provided BibTeX content contains syntax errors or unclosed delimiters',
  ) {
    super(message);
    this.name = 'InvalidBibtexException';
    Object.setPrototypeOf(this, InvalidBibtexException.prototype);
  }
}
