import { PagesDomainError } from '@/modules/pages/core/domain/pages-domain.error';

/**
 * citations/domain/exceptions/identifier-not-found.exception.ts
 * Thrown when an academic DOI or arXiv ID cannot be resolved by external catalogs.
 */

export class IdentifierNotFoundException extends PagesDomainError {
  constructor(public readonly identifier: string) {
    super(
      `Academic identifier '${identifier}' could not be resolved from CrossRef or arXiv`,
      {
        code: 'CITATION_IDENTIFIER_NOT_FOUND',
        statusCode: 404,
      },
    );
  }
}

/**
 * citations/domain/exceptions/invalid-bibtex.exception.ts
 * Thrown when raw BibTeX text has syntax errors or malformed structure.
 */

export class InvalidBibtexException extends PagesDomainError {
  constructor(
    message = 'The provided BibTeX content contains syntax errors or unclosed delimiters',
  ) {
    super(message, {
      code: 'INVALID_BIBTEX',
      statusCode: 400,
    });
  }
}
