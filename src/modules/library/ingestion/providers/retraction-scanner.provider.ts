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

    if (cleanDoiVal || cleanPmidVal) {
      try {
        const { retraction, isVerifiedClean } =
          await this.queryOnlineRetraction(cleanDoiVal, cleanPmidVal);
        if (retraction) {
          if (cleanDoiVal) {
            await this.retractionDb.saveRetraction(
              cleanDoiVal,
              retraction,
              cleanPmidVal,
            );
          }
          return { status: 'retracted', details: retraction };
        }
        if (isVerifiedClean) {
          if (cleanDoiVal) {
            await this.retractionDb.saveClean(cleanDoiVal, cleanPmidVal);
          }
          return { status: 'clean' };
        }
      } catch (err: any) {
        this.logger.debug(
          `Online retraction scan for ${cleanDoiVal || cleanPmidVal} skipped/failed: ${err?.message}`,
        );
      }
    }

    return { status: 'unknown' };
  }

  /**
   * Enterprise Online Retraction Detection (Standardized via OpenAlex & CrossRef):
   * 1. OpenAlex API: Ingests the entire Retraction Watch database (~55,000+ papers). Catches historical and preprint retractions.
   * 2. CrossRef CrossMark API: Real-time publisher update-to notices and retraction assertions.
   */
  private async queryOnlineRetraction(
    doi?: string | null,
    pmid?: string | null,
  ): Promise<{
    retraction: RetractionDetails | null;
    isVerifiedClean: boolean;
  }> {
    const mailto = getAcademicContactEmail();

    // ── Tier 1: Check OpenAlex (Full Retraction Watch Registry) ─────────────
    try {
      const openalexTarget = doi
        ? `https://doi.org/${doi}`
        : pmid
          ? `pmid:${pmid}`
          : null;

      if (openalexTarget) {
        const oaUrl = `https://api.openalex.org/works/${encodeURIComponent(openalexTarget)}?mailto=${encodeURIComponent(mailto)}`;
        const oaRes = await fetch(oaUrl, {
          signal: AbortSignal.timeout(3500),
          headers: {
            'User-Agent': getAcademicUserAgent('RetractionScanner'),
            Accept: 'application/json',
          },
        });

        if (oaRes.ok) {
          const oaData: any = await oaRes.json();
          if (oaData?.is_retracted === true) {
            return {
              retraction: {
                nature: 'retraction',
                reason:
                  'Retracted according to Retraction Watch & OpenAlex global registry',
                noticeUrl: oaData.doi
                  ? (oaData.doi.startsWith('http') ? oaData.doi : `https://doi.org/${oaData.doi}`)
                  : undefined,
                date: oaData.publication_date || undefined,
                source: 'openalex',
              },
              isVerifiedClean: false,
            };
          }
        }
      }
    } catch (oaErr: any) {
      this.logger.debug(
        `[RetractionScanner] OpenAlex check skipped/failed: ${oaErr?.message}`,
      );
    }

    // ── Tier 2: Check CrossRef CrossMark (Real-Time Publisher Notices) ──────
    if (doi) {
      try {
        const crUrl = `https://api.crossref.org/works/${encodeURIComponent(doi)}?mailto=${encodeURIComponent(mailto)}`;
        const crRes = await fetch(crUrl, {
          signal: AbortSignal.timeout(3500),
          headers: {
            'User-Agent': getAcademicUserAgent('RetractionScanner'),
            Accept: 'application/json',
          },
        });

        if (crRes.ok) {
          const crData: any = await crRes.json();
          const message = crData?.message;

          const updateTo = message?.['update-to'];
          if (Array.isArray(updateTo) && updateTo.length > 0) {
            for (const update of updateTo) {
              const updateType = (update.type || '').toLowerCase();
              const updateNoticeUrl = update.doi
                ? (update.doi.startsWith('http') ? update.doi : `https://doi.org/${update.doi}`)
                : undefined;
              if (updateType === 'retraction') {
                return {
                  retraction: {
                    nature: 'retraction',
                    reason: update.label || 'Retracted by publisher',
                    noticeUrl: updateNoticeUrl,
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
                    noticeUrl: updateNoticeUrl,
                    source: 'crossref',
                  },
                  isVerifiedClean: false,
                };
              }
            }
          }

          const assertions = message?.assertion;
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
        }
      } catch (crErr: any) {
        this.logger.debug(
          `[RetractionScanner] Crossref check failed for DOI "${doi}": ${crErr?.message}`,
        );
      }
    }

    return { retraction: null, isVerifiedClean: false };
  }
}
