import { Injectable, Logger } from '@nestjs/common';
import {
  IExternalSearchProvider,
  ExternalSearchOptions,
  ExternalSearchResult,
  ExternalSearchPaperHit,
} from '@/modules/library/ingestion/types/external-search.types';
import { cleanAbstractText } from '@/modules/library/shared-kernel/domain/bibliographic.domain';

const DEFAULT_TIMEOUT_MS = 6000;
const DEFAULT_LIMIT = 5;

@Injectable()
export class EuropePmcSearchProvider implements IExternalSearchProvider {
  readonly providerName = 'europepmc';
  private readonly logger = new Logger(EuropePmcSearchProvider.name);

  async isAvailable(): Promise<boolean> {
    return true; // Public open access academic mirror
  }

  async search(
    query: string,
    options?: ExternalSearchOptions,
  ): Promise<ExternalSearchResult> {
    const startTime = Date.now();
    const timeoutMs = options?.timeoutMs || DEFAULT_TIMEOUT_MS;
    const limit = options?.limit || DEFAULT_LIMIT;

    try {
      const endpoint = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(
        query,
      )}&format=json&pageSize=${limit}&resultType=core`;

      const signal = AbortSignal.timeout(timeoutMs);
      const res = await fetch(endpoint, {
        headers: { Accept: 'application/json' },
        signal,
      });

      const latencyMs = Date.now() - startTime;

      if (!res.ok) {
        return {
          provider: this.providerName,
          query,
          hits: [],
          latencyMs,
          isAvailable: true,
          statusCode: res.status,
          error: `EuropePMC returned HTTP ${res.status}: ${res.statusText}`,
        };
      }

      const data = await res.json();
      const records = Array.isArray(data?.resultList?.result)
        ? data.resultList.result
        : [];

      const hits: ExternalSearchPaperHit[] = records.map((record: unknown) =>
        this.mapToHit(record as Record<string, unknown>),
      );

      return {
        provider: this.providerName,
        query,
        hits,
        latencyMs,
        isAvailable: true,
        statusCode: 200,
      };
    } catch (err: unknown) {
      const latencyMs = Date.now() - startTime;
      const isAbort =
        err &&
        typeof err === 'object' &&
        ((err as { name?: string }).name === 'TimeoutError' ||
          (err as { name?: string }).name === 'AbortError');
      const errorMessage = isAbort
        ? `EuropePMC timeout after ${timeoutMs}ms`
        : `EuropePMC error: ${err instanceof Error ? err.message : 'Unknown'}`;

      this.logger.debug(errorMessage);

      return {
        provider: this.providerName,
        query,
        hits: [],
        latencyMs,
        isAvailable: false,
        error: errorMessage,
      };
    }
  }

  private mapToHit(record: Record<string, unknown>): ExternalSearchPaperHit {
    const title = String(record.title || '')
      .replace(/<[^>]+>/g, '')
      .trim();
    const doi = typeof record.doi === 'string' ? record.doi : undefined;
    const pmid = typeof record.pmid === 'string' ? record.pmid : undefined;
    const pmcid = typeof record.pmcid === 'string' ? record.pmcid : undefined;

    const authors: string[] = [];
    const authorList = (
      record.authorList as
        | {
            author?: Array<{
              fullName?: string;
              lastName?: string;
              firstName?: string;
            }>;
          }
        | undefined
    )?.author;
    if (Array.isArray(authorList)) {
      for (const a of authorList) {
        if (a.fullName) authors.push(a.fullName.trim());
        else if (a.lastName) {
          authors.push(
            `${a.firstName ? a.firstName + ' ' : ''}${a.lastName}`.trim(),
          );
        }
      }
    }

    let pdfUrl: string | undefined;
    const fullTextUrls = (
      record.fullTextUrlList as
        | { fullTextUrl?: Array<{ documentStyle?: string; url?: string }> }
        | undefined
    )?.fullTextUrl;
    if (Array.isArray(fullTextUrls)) {
      const pdfEntry = fullTextUrls.find(
        (u) =>
          u.documentStyle === 'pdf' ||
          (typeof u.url === 'string' && u.url.toLowerCase().endsWith('.pdf')),
      );
      if (pdfEntry?.url) {
        pdfUrl = pdfEntry.url;
      }
    }

    const year =
      typeof record.pubYear === 'string'
        ? parseInt(record.pubYear, 10)
        : typeof record.pubYear === 'number'
          ? record.pubYear
          : undefined;
    const cleanAbstract =
      typeof record.abstractText === 'string'
        ? cleanAbstractText(record.abstractText.replace(/<[^>]+>/g, ' '))
        : undefined;

    const url = doi
      ? `https://doi.org/${doi}`
      : pmid
        ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}`
        : `https://europepmc.org/article/${record.source || 'MED'}/${record.id}`;

    // Scoring
    let confidenceScore = 0.0;
    if (doi || pmid) confidenceScore += 0.4;
    if (title.length > 5) confidenceScore += 0.3;
    confidenceScore += 0.2; // Authoritative scientific database
    if (pdfUrl) confidenceScore += 0.1;

    return {
      title,
      url,
      snippet: cleanAbstract,
      authors: authors.length > 0 ? authors : undefined,
      year,
      doi,
      pmid,
      pdfUrl,
      sourceEngine: 'europepmc',
      confidenceScore: Math.min(1.0, Math.round(confidenceScore * 100) / 100),
      rawMetadata: {
        journalTitle: record.journalTitle,
        isOpenAccess: record.isOpenAccess === 'Y',
        pmcid,
      },
    };
  }
}
