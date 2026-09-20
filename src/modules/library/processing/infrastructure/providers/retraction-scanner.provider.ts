import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../../../core/database/prisma.service';
import { RetractionDetails } from '../../domain/types/retraction.types';
import { RetractionDatabaseService } from '../../application/services/retraction-database.service';
import {
  getAcademicContactEmail,
  getAcademicUserAgent,
} from '../../../shared-kernel/core/constants/academic-client.constants';

@Injectable()
export class RetractionScannerProvider {
  private readonly logger = new Logger(RetractionScannerProvider.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly retractionDb: RetractionDatabaseService,
  ) {}

  /**
   * Scans a DOI and/or title for retraction markers.
   * Checks local Retraction Watch dataset & in-memory index first (0ms),
   * then title heuristics, then external provider.
   */
  async scan(
    doi?: string | null,
    pmid?: string | null,
    title?: string | null,
  ): Promise<RetractionDetails | null> {
    const cleanDoiVal = doi?.trim().toLowerCase();
    const cleanPmidVal = pmid?.trim();

    // 1. Check local Retraction Watch dataset & in-memory fast index
    if (cleanDoiVal || cleanPmidVal) {
      const localResult = await this.retractionDb.checkRetraction(
        cleanDoiVal,
        cleanPmidVal,
      );

      if (localResult === false) {
        // Confirmed clean via verified cache / known non-retracted paper
        return null;
      }

      if (localResult) {
        // Confirmed retracted from Retraction Watch seed dataset or local DB
        return localResult;
      }
    }

    // 2. Check title heuristics (many publishers or databases prepend "RETRACTED:" or "WITHDRAWN:")
    if (title) {
      const lowerTitle = title.trim().toLowerCase();
      if (
        lowerTitle.startsWith('retracted:') ||
        lowerTitle.startsWith('retraction:') ||
        lowerTitle.startsWith('withdrawn:') ||
        lowerTitle.includes('(retracted)') ||
        lowerTitle.includes('[retracted]')
      ) {
        return {
          nature: 'retraction',
          reason: 'Identified from publication title notation',
          source: 'manual',
        };
      }
      if (
        lowerTitle.startsWith('expression of concern:') ||
        lowerTitle.includes('expression of concern')
      ) {
        return {
          nature: 'expression_of_concern',
          reason: 'Identified from publication title notation',
          source: 'manual',
        };
      }
    }

    // 3. Online Scan via Crossref / OpenAlex if DOI is available
    if (cleanDoiVal) {
      try {
        const { retraction, isVerifiedClean } =
          await this.queryOnlineRetraction(cleanDoiVal);
        if (retraction) {
          // Save to local retraction database
          await this.retractionDb.saveRetraction(
            cleanDoiVal,
            retraction,
            cleanPmidVal,
          );
          return retraction;
        } else if (isVerifiedClean) {
          // Record as verified clean only when online API successfully returned 200 with no retraction notices
          await this.retractionDb.saveClean(cleanDoiVal, cleanPmidVal);
        }
      } catch (err: any) {
        this.logger.debug(
          `Online retraction scan for ${cleanDoiVal} skipped/failed: ${err?.message}`,
        );
      }
    }

    return null;
  }

  private async queryOnlineRetraction(doi: string): Promise<{
    retraction: RetractionDetails | null;
    isVerifiedClean: boolean;
  }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);

    try {
      // Query Crossref API with timeout and polite pool
      const mailto = getAcademicContactEmail();
      const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}?mailto=${encodeURIComponent(mailto)}`;
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': getAcademicUserAgent('RetractionScanner'),
        },
      });

      if (!res.ok) {
        return { retraction: null, isVerifiedClean: false };
      }
      const data: any = await res.json();
      const message = data?.message;
      if (!message) {
        return { retraction: null, isVerifiedClean: false };
      }

      // Check Crossref update-to relations
      const updateTo = message['update-to'];
      if (Array.isArray(updateTo) && updateTo.length > 0) {
        for (const update of updateTo) {
          const updateType = (update.type || '').toLowerCase();
          if (updateType === 'retraction') {
            return {
              retraction: {
                nature: 'retraction',
                reason: update.label || 'Retracted by publisher',
                noticeUrl: update.doi
                  ? `https://doi.org/${update.doi}`
                  : undefined,
                date: update.updated?.['date-time'] || undefined,
                source: 'crossref',
              },
              isVerifiedClean: false,
            };
          }
          if (
            updateType === 'expression_of_concern' ||
            updateType === 'concern'
          ) {
            return {
              retraction: {
                nature: 'expression_of_concern',
                reason:
                  update.label || 'Publisher issued expression of concern',
                noticeUrl: update.doi
                  ? `https://doi.org/${update.doi}`
                  : undefined,
                source: 'crossref',
              },
              isVerifiedClean: false,
            };
          }
        }
      }

      // Check Crossref assertions
      const assertions = message.assertion;
      if (Array.isArray(assertions)) {
        for (const ass of assertions) {
          const name = (ass.name || '').toLowerCase();
          if (name === 'retraction' || name === 'retracted') {
            return {
              retraction: {
                nature: 'retraction',
                reason: ass.value || 'Publisher retraction notice recorded',
                source: 'crossref',
              },
              isVerifiedClean: false,
            };
          }
        }
      }

      // 200 OK received with valid payload and no retraction notices found
      return { retraction: null, isVerifiedClean: true };
    } catch {
      // Network timeout, connection abort, or JSON parse failure: transient error, not clean
      return { retraction: null, isVerifiedClean: false };
    } finally {
      clearTimeout(timeout);
    }
  }
}
