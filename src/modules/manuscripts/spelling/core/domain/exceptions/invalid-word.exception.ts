/**
 * spelling/core/domain/exceptions/invalid-word.exception.ts
 * Thrown when attempting to learn or check an invalid word (e.g. empty or containing whitespace/special characters).
 */

export class InvalidWordException extends Error {
  constructor(word: string, reason?: string) {
    super(`Invalid word '${word}'${reason ? `: ${reason}` : ''}. Words must be non-empty alphabetic strings.`);
    this.name = 'InvalidWordException';
  }
}
