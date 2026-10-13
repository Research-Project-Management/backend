import { Injectable, Logger } from '@nestjs/common';
import {
  IExternalSearchProvider,
  ExternalSearchOptions,
  ExternalSearchResult,
  ExternalSearchPaperHit,
} from '../types/external-search.types';
import {
  cleanAbstractText,
} from '../../shared-kernel/utils/bibliographic.utils';

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

      const data = (await res.json()) as any;
      const records = Array.isArray(data?.resultList?.result)
        ? data.resultList.result
        : [];

      const hits: ExternalSearchPaperHit[] = records.map((record: any) =>
        this.mapToHit(record),
      );

      return {
        provider: this.providerName,
        query,
        hits,
        latencyMs,
        isAvailable: true,
        statusCode: 200,
      };
    } catch (err: any) {
      const latencyMs = Date.now() - startTime;
      const isAbort = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      const errorMessage = isAbort
        ? `EuropePMC timeout after ${timeoutMs}ms`
        : `EuropePMC error: ${err?.message || 'Unknown'}`;

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

  private mapToHit(record: any): ExternalSearchPaperHit {
    const title = (record.title || '').replace(/<[^>]+>/g, '').trim();
    const doi = record.doi;
    const pmid = record.pmid;
    const pmcid = record.pmcid;

    const authors: string[] = [];
    if (Array.isArray(record.authorList?.author)) {
      for (const a of record.authorList.author) {
        if (a.fullName) authors.push(a.fullName.trim());
        else if (a.lastName) {
          authors.push(
            `${a.firstName ? a.firstName + ' ' : ''}${a.lastName}`.trim(),
          );
        }
      }
    }

    let pdfUrl: string | undefined;
    if (Array.isArray(record.fullTextUrlList?.fullTextUrl)) {
      const pdfEntry = record.fullTextUrlList.fullTextUrl.find(
        (u: any) =>
          u.documentStyle === 'pdf' ||
          (typeof u.url === 'string' && u.url.toLowerCase().endsWith('.pdf')),
      );
      if (pdfEntry?.url) {
        pdfUrl = pdfEntry.url;
      }
    }

    const year = record.pubYear ? parseInt(record.pubYear, 10) : undefined;
    const cleanAbstract = record.abstractText
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
