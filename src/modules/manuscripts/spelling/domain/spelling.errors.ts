/**
 * spelling/core/domain/exceptions/invalid-word.exception.ts
 * Thrown when attempting to learn or check an invalid word (e.g. empty or containing whitespace/special characters).
 */

export class InvalidWordException extends Error {
  constructor(word: string, reason?: string) {
    super(
      `Invalid word '${word}'${reason ? `: ${reason}` : ''}. Words must be non-empty alphabetic strings.`,
    );
    this.name = 'InvalidWordException';
  }
}

/**
 * spelling/core/domain/exceptions/unsupported-language.exception.ts
 * Thrown when an unknown or unsupported language code is provided for spell checking.
 */

export class UnsupportedLanguageException extends Error {
  constructor(language: string) {
    super(
      `Unsupported spelling language code '${language}'. Supported: en, en-US, en-GB, vi, vi-VN, fr, de, es.`,
    );
    this.name = 'UnsupportedLanguageException';
  }
}
