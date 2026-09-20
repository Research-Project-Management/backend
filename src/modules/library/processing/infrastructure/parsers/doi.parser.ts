import { Injectable } from '@nestjs/common';
import { IngestionValidationException } from '../../domain/errors/ingestion.errors';
import { normalizeDoi } from '../../../catalog/application/utils/items.utils';

@Injectable()
export class DoiParser {
  /**
   * Normalizes a raw DOI string by stripping URL prefixes, resolver schemes,
   * leading/trailing whitespace, publisher URLs (Nature, Zenodo, PLOS, BioRxiv),
   * and converting to lowercase.
   */
  normalize(rawDoi: string): string {
    if (!rawDoi || typeof rawDoi !== 'string' || !rawDoi.trim()) {
      throw new IngestionValidationException('DOI must be a non-empty string');
    }

    const normalized = normalizeDoi(rawDoi);
    if (!normalized) {
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
