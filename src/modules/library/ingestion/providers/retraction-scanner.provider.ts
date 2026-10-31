import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  RetractionDetails,
  RetractionLookupResult,
} from '@/modules/library/ingestion/types/retraction.types';
import { RetractionDatabaseService } from '@/modules/library/ingestion/services/retraction-database.service';
import {
  getAcademicContactEmail,
  getAcademicUserAgent,
} from '@/modules/library/core/constants/academic-client.constants';
import {
  normalizeDoi,
  normalizePmid,
  AcademicHttpClient,
} from '@/modules/library/core';

@Injectable()
export class RetractionScannerProvider {
  private readonly logger = new Logger(RetractionScannerProvider.name);

  async checkRetraction(
    doi?: string | null,
    pmid?: string | null,
    options?: { localOnly?: boolean },
  ): Promise<RetractionLookupResult> {
    return this.lookup(doi, pmid, options);
  }
  constructor(
    private readonly retractionDb: RetractionDatabaseService,
    @Optional() private readonly httpClient?: AcademicHttpClient,
  ) {}

  /**
   * Looks a paper up by DOI and/or PMID only (same matching keys as Zotero).
   * Order: local Retraction Watch dataset / in-memory index, then Crossref.
   */
  async lookup(
    doi?: string | null,
    pmid?: string | null,
    options?: { localOnly?: boolean },
  ): Promise<RetractionLookupResult> {
    const cleanDoiVal = doi
      ? normalizeDoi(doi) || doi.trim().toLowerCase()
      : undefined;
    const cleanPmidVal = pmid ? normalizePmid(pmid) || pmid.trim() : undefined;

    if (!cleanDoiVal && !cleanPmidVal) {
      return { status: 'unknown' };
    }

    const localResult = await this.retractionDb.checkRetraction(
      cleanDoiVal,
      cleanPmidVal,
    );
    if (localResult === false) return { status: 'clean' };
    if (localResult) return { status: 'retracted', details: localResult };

    if (options?.localOnly) {
      return { status: 'unknown' };
    }

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
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.debug(
          `Online retraction scan for ${cleanDoiVal || cleanPmidVal} skipped/failed: ${msg}`,
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
  private async executeFetch(
    url: string,
    options?: RequestInit,
  ): Promise<{ response: Response; attempts: number }> {
    if (this.httpClient) {
      const res = await this.httpClient.request(url, {
        signal: options?.signal ?? undefined,
        headers: options?.headers as Record<string, string> | undefined,
      });
      return { response: res.response, attempts: 1 };
    }
    const response = await fetch(url, options);
    return { response, attempts: 1 };
  }

  private async queryOnlineRetraction(
    doi?: string | null,
    pmid?: string | null,
  ): Promise<{
    retraction: RetractionDetails | null;
    isVerifiedClean: boolean;
  }> {
    const mailto = getAcademicContactEmail();

    // Tier 1: Check OpenAlex (Full Retraction Watch Registry)
    try {
      const openalexTarget = doi
        ? `https://doi.org/${doi}`
        : pmid
          ? `pmid:${pmid}`
          : null;

      if (openalexTarget) {
        const oaUrl = `https://api.openalex.org/works/${encodeURIComponent(openalexTarget)}?mailto=${encodeURIComponent(mailto)}`;
        const oaHeaders = {
          'User-Agent': getAcademicUserAgent('RetractionScanner'),
          Accept: 'application/json',
        };
        const oaSignal = AbortSignal.timeout(3500);
        const { response: oaRes } = await this.executeFetch(oaUrl, {
          headers: oaHeaders,
          signal: oaSignal,
        });

        if (oaRes.ok) {
          const oaData = (await oaRes.json()) as {
            is_retracted?: boolean;
            doi?: string;
            publication_date?: string;
          } | null;
          if (oaData?.is_retracted === true) {
            return {
              retraction: {
                nature: 'retraction',
                reason:
                  'Retracted according to Retraction Watch & OpenAlex global registry',
                noticeUrl: oaData.doi
                  ? oaData.doi.startsWith('http')
                    ? oaData.doi
                    : `https://doi.org/${oaData.doi}`
                  : undefined,
                date: oaData.publication_date || undefined,
                source: 'openalex',
              },
              isVerifiedClean: false,
            };
          }
        }
      }
    } catch (oaErr: unknown) {
      const msg = oaErr instanceof Error ? oaErr.message : String(oaErr);
      this.logger.debug(
        `[RetractionScanner] OpenAlex check skipped/failed: ${msg}`,
      );
    }

    // Tier 2: Check CrossRef CrossMark (Real-Time Publisher Notices)
    if (doi) {
      try {
        const crUrl = `https://api.crossref.org/works/${encodeURIComponent(doi)}?mailto=${encodeURIComponent(mailto)}`;
        const crHeaders = {
          'User-Agent': getAcademicUserAgent('RetractionScanner'),
          Accept: 'application/json',
        };
        const crSignal = AbortSignal.timeout(3500);
        const { response: crRes } = await this.executeFetch(crUrl, {
          headers: crHeaders,
          signal: crSignal,
        });

        if (crRes.ok) {
          const crData = (await crRes.json()) as {
            message?: {
              'update-to'?: Array<{
                type?: string;
                doi?: string;
                label?: string;
                updated?: { 'date-time'?: string };
              }>;
              'updated-by'?: Array<{
                type?: string;
                doi?: string;
                label?: string;
                updated?: { 'date-time'?: string };
              }>;
              assertion?: Array<{
                name?: string;
                value?: string;
              }>;
            };
          } | null;
          const message = crData?.message;

          const updateTo = [
            ...(Array.isArray(message?.['updated-by'])
              ? message['updated-by']
              : []),
            ...(Array.isArray(message?.['update-to'])
              ? message['update-to']
              : []),
          ];
          if (Array.isArray(updateTo) && updateTo.length > 0) {
            let bestNotice: RetractionDetails | null = null;
            let bestRank = 0;

            for (const update of updateTo) {
              const updateType = (update.type || '').toLowerCase();
              const updateNoticeUrl = update.doi
                ? update.doi.startsWith('http')
                  ? update.doi
                  : `https://doi.org/${update.doi}`
                : undefined;
              if (
                updateType === 'retraction' ||
                updateType === 'withdrawal' ||
                updateType === 'removal'
              ) {
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
                (updateType === 'expression_of_concern' ||
                  updateType === 'expression-of-concern' ||
                  updateType === 'concern') &&
                bestRank < 2
              ) {
                bestRank = 2;
                bestNotice = {
                  nature: 'expression_of_concern',
                  reason:
                    update.label || 'Publisher issued expression of concern',
                  noticeUrl: updateNoticeUrl,
                  date: update.updated?.['date-time'] || undefined,
                  source: 'crossref',
                };
              } else if (
                (updateType === 'correction' ||
                  updateType === 'erratum' ||
                  updateType === 'corrigendum') &&
                bestRank < 1
              ) {
                bestRank = 1;
                bestNotice = {
                  nature: 'correction',
                  reason: update.label || 'Publisher issued correction',
                  noticeUrl: updateNoticeUrl,
                  date: update.updated?.['date-time'] || undefined,
                  source: 'crossref',
                };
              }
            }

            if (bestNotice) {
              return {
                retraction: bestNotice,
                isVerifiedClean: false,
              };
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
      } catch (crErr: unknown) {
        const msg = crErr instanceof Error ? crErr.message : String(crErr);
        this.logger.debug(
          `[RetractionScanner] Crossref check failed for DOI "${doi}": ${msg}`,
        );
      }
    }

    return { retraction: null, isVerifiedClean: false };
  }
}

export { RetractionScannerProvider as RetractionScannerService };
