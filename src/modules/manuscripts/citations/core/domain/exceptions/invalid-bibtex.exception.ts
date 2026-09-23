/**
 * citations/core/domain/exceptions/invalid-bibtex.exception.ts
 * Thrown when raw BibTeX text has syntax errors or malformed structure.
 */

export class InvalidBibtexException extends Error {
  constructor(message = 'The provided BibTeX content contains syntax errors or unclosed delimiters') {
    super(message);
    this.name = 'InvalidBibtexException';
    Object.setPrototypeOf(this, InvalidBibtexException.prototype);
  }
}
