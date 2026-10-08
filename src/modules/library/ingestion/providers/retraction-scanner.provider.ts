import { Injectable, Logger } from '@nestjs/common';
import {
  RetractionDetails,
  RetractionLookupResult,
} from '../types/retraction.types';
import { RetractionDatabaseService } from '../services/retraction-database.service';
import {
  getAcademicContactEmail,
  getAcademicUserAgent,
} from '../../shared-kernel/core/constants/academic-client.constants';

@Injectable()
export class RetractionScannerProvider {
  private readonly logger = new Logger(RetractionScannerProvider.name);
  constructor(private readonly retractionDb: RetractionDatabaseService) {}

  /**
   * Compatibility wrapper: returns retraction details, or null when the item is
   * not (known to be) retracted. Use `lookup()` when the caller must tell
   * "verified clean" apart from "could not be verified".
   */
  async scan(
    doi?: string | null,
    pmid?: string | null,
    _title?: string | null,
  ): Promise<RetractionDetails | null> {
    const result = await this.lookup(doi, pmid);
    return result.status === 'retracted' ? result.details : null;
  }

  /**
   * Looks a paper up by DOI and/or PMID only (same matching keys as Zotero).
   * Order: local Retraction Watch dataset / in-memory index, then Crossref.
   */
  async lookup(
    doi?: string | null,
    pmid?: string | null,
  ): Promise<RetractionLookupResult> {
    const cleanDoiVal = doi?.trim().toLowerCase();
    const cleanPmidVal = pmid?.trim();

    if (!cleanDoiVal && !cleanPmidVal) {
      return { status: 'unknown' };
    }

    const localResult = await this.retractionDb.checkRetraction(
      cleanDoiVal,
      cleanPmidVal,
    );
    if (localResult === false) return { status: 'clean' };
    if (localResult) return { status: 'retracted', details: localResult };

    if (cleanDoiVal) {
      try {
        const { retraction, isVerifiedClean } =
          await this.queryOnlineRetraction(cleanDoiVal);
        if (retraction) {
          await this.retractionDb.saveRetraction(
            cleanDoiVal,
            retraction,
            cleanPmidVal,
          );
          return { status: 'retracted', details: retraction };
        }
        if (isVerifiedClean) {
          await this.retractionDb.saveClean(cleanDoiVal, cleanPmidVal);
          return { status: 'clean' };
        }
      } catch (err: any) {
        this.logger.debug(
          `Online retraction scan for ${cleanDoiVal} skipped/failed: ${err?.message}`,
        );
      }
    }

    return { status: 'unknown' };
  }

  private async queryOnlineRetraction(doi: string): Promise<{
    retraction: RetractionDetails | null;
    isVerifiedClean: boolean;
  }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);

    try {
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

      return { retraction: null, isVerifiedClean: true };
    } catch (err: any) {
      this.logger.debug(
        `[RetractionScanner] Crossref check failed for DOI "${doi}": ${err?.message}`,
      );
      return { retraction: null, isVerifiedClean: false };
    } finally {
      clearTimeout(timeout);
    }
  }
}
