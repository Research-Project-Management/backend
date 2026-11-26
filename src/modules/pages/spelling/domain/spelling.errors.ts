/**
 * spelling/domain/spelling.errors.ts
 * Domain exceptions for the Pages Spelling subsystem.
 */

import { PagesDomainError } from '@/modules/pages/core/domain/pages-domain.error';

export class InvalidWordException extends PagesDomainError {
  constructor(word: string, reason?: string) {
    super(
      `Invalid word '${word}'${reason ? `: ${reason}` : ''}. Words must be non-empty single tokens.`,
      {
        code: 'INVALID_SPELLING_WORD',
        statusCode: 400,
      },
    );
  }
}

export class UnsupportedLanguageException extends PagesDomainError {
  constructor(language: string, supportedLanguages?: readonly string[]) {
    const suffix = supportedLanguages?.length
      ? ` Supported: ${supportedLanguages.join(', ')}.`
      : '';
    super(`Unsupported spelling language code '${language}'.${suffix}`, {
      code: 'UNSUPPORTED_SPELLING_LANGUAGE',
      statusCode: 400,
    });
  }
}
