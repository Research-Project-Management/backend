import { Injectable } from '@nestjs/common';
import { IngestionValidationException } from '../errors/ingestion.errors';

@Injectable()
export class DoiParser {
  private static readonly DOI_REGEX = /^10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+$/;

  /**
   * Normalizes a raw DOI string by stripping URL prefixes, resolver schemes,
   * leading/trailing whitespace and converting to lowercase.
   */
  normalize(rawDoi: string): string {
    if (!rawDoi || typeof rawDoi !== 'string') {
      throw new IngestionValidationException('DOI must be a non-empty string');
    }

    let clean = rawDoi.trim();

    // Strip URL prefixes
    clean = clean.replace(/^(https?:\/\/)?(dx\.)?doi\.org\//i, '');
    clean = clean.replace(/^doi:\s*/i, '');

    // Trim trailing punctuation (common copy-paste issue e.g. dot or semicolon at end of sentence)
    clean = clean.replace(/[.,;]+$/, '').trim();

    const normalized = clean.toLowerCase();

    if (!DoiParser.DOI_REGEX.test(normalized)) {
      throw new IngestionValidationException(
        `Invalid DOI syntax format: "${rawDoi}"`,
      );
    }

    return normalized;
  }

  /**
   * Checks whether a raw string looks like a valid DOI.
   */
  isValid(rawDoi: string): boolean {
    try {
      this.normalize(rawDoi);
      return true;
    } catch {
      return false;
    }
  }
}
