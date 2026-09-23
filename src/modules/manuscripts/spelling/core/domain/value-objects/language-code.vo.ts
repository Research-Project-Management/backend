/**
 * spelling/core/domain/value-objects/language-code.vo.ts
 * Value Object representing a validated language code for spell checking.
 */

import { UnsupportedLanguageException } from '../exceptions/unsupported-language.exception';

export class LanguageCodeVo {
  private static readonly SUPPORTED_CODES = new Set([
    'en',
    'en-us',
    'en-gb',
    'en-ca',
    'vi',
    'vi-vn',
    'fr',
    'fr-fr',
    'de',
    'de-de',
    'es',
    'es-es',
  ]);

  public readonly code: string;
  public readonly baseLanguage: string;

  private constructor(normalizedCode: string) {
    this.code = normalizedCode;
    this.baseLanguage = normalizedCode.split('-')[0] || normalizedCode;
  }

  public static create(raw?: string): LanguageCodeVo {
    if (!raw || raw.trim() === '') {
      return new LanguageCodeVo('en-us');
    }

    const normalized = raw.trim().toLowerCase().replace('_', '-');
    if (!LanguageCodeVo.SUPPORTED_CODES.has(normalized)) {
      throw new UnsupportedLanguageException(raw);
    }

    return new LanguageCodeVo(normalized);
  }

  public isEnglish(): boolean {
    return this.baseLanguage === 'en';
  }

  public equals(other: LanguageCodeVo): boolean {
    return this.code === other.code;
  }

  public toString(): string {
    return this.code;
  }
}
