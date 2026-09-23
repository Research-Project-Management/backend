/**
 * spelling/core/domain/exceptions/unsupported-language.exception.ts
 * Thrown when an unknown or unsupported language code is provided for spell checking.
 */

export class UnsupportedLanguageException extends Error {
  constructor(language: string) {
    super(`Unsupported spelling language code '${language}'. Supported: en, en-US, en-GB, vi, vi-VN, fr, de, es.`);
    this.name = 'UnsupportedLanguageException';
  }
}
