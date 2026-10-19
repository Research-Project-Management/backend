import { Injectable, Logger, Optional } from '@nestjs/common';
import { MirrorBibliographicMetadata } from '@/modules/library/ingestion/types/web-fetch.types';
import {
  AcademicHttpClient,
  LibraryConfigService,
  cleanAbstractText,
} from '@/modules/library/core';
import { CrossRefProvider } from '@/modules/library/ingestion/providers/crossref.provider';
import { ArxivProvider } from '@/modules/library/ingestion/providers/arxiv.provider';
import { OpenAlexProvider } from '@/modules/library/ingestion/providers/openalex.provider';

interface EuropePmcAuthor {
  fullName?: string;
  firstName?: string;
  lastName?: string;
}

interface EuropePmcFullTextUrl {
  documentStyle?: string;
  url?: string;
}

interface EuropePmcRecord {
  title?: string;
  abstractText?: string;
  pubYear?: string;
  doi?: string;
  pmid?: string;
  pmcid?: string;
  journalTitle?: string;
  journalInfo?: { journal?: { title?: string } };
  bookOrReportDetails?: { publisher?: string };
  isOpenAccess?: string;
  authorString?: string;
  authorList?: { author?: EuropePmcAuthor[] };
  fullTextUrlList?: { fullTextUrl?: EuropePmcFullTextUrl[] };
}

interface EuropePmcResponse {
  resultList?: { result?: EuropePmcRecord[] };
}

/**
 * Open Academic Mirror Resolver Service (Ladder Step 2).
 * Queries public, free academic APIs (EuropePMC, CrossRef, arXiv, OpenAlex)
 * to resolve authoritative bibliographic metadata and Open Access PDFs
 * without triggering publisher anti-bot WAFs.
 */
@Injectable()
export class WebMirrorResolverService {
  private readonly logger = new Logger(WebMirrorResolverService.name);

  constructor(
    @Optional() private readonly httpClient?: AcademicHttpClient,
    @Optional() private readonly configService?: LibraryConfigService,
    private readonly crossRefProvider?: CrossRefProvider,
    private readonly arxivProvider?: ArxivProvider,
    private readonly openAlexProvider?: OpenAlexProvider,
  ) {}

  private mapProviderResultToMirror(
    metadata: Record<string, unknown>,
    sourceMirror: 'CrossRef' | 'arXiv' | 'OpenAlex',
    fallbackDoi?: string,
  ): MirrorBibliographicMetadata | null {
    const title =
      typeof metadata.title === 'string' ? metadata.title.trim() : '';
    if (!title) return null;
    const authors = Array.isArray(metadata.authors)
      ? (metadata.authors as string[]).filter(Boolean)
      : undefined;
    const journal =
      (typeof metadata.journal === 'string' && metadata.journal) ||
      (typeof metadata.publicationTitle === 'string' &&
        metadata.publicationTitle) ||
      (typeof metadata.publisher === 'string' && metadata.publisher) ||
      undefined;
    const pdfUrl =
      (typeof metadata.openAccessPdfUrl === 'string' &&
        metadata.openAccessPdfUrl) ||
      (typeof metadata.pdfUrl === 'string' && metadata.pdfUrl) ||
      undefined;
    return {
      title,
      abstract:
        typeof metadata.abstract === 'string' ? metadata.abstract : undefined,
      authors: authors && authors.length > 0 ? authors : undefined,
      year: typeof metadata.year === 'number' ? metadata.year : undefined,
      doi: (typeof metadata.doi === 'string' && metadata.doi) || fallbackDoi,
      pmid: typeof metadata.pmid === 'string' ? metadata.pmid : undefined,
      pmcid: typeof metadata.pmcid === 'string' ? metadata.pmcid : undefined,
      journal,
      isOpenAccess: sourceMirror === 'arXiv' || Boolean(pdfUrl),
      pdfUrl,
      sourceMirror,
    };
  }

  /**
   * Ladder Step 2: Query EuropePMC public open API to resolve metadata without WAF interference.
   */
  async resolveOpenMirror(
    doi?: string,
    pmid?: string,
    pmcid?: string,
  ): Promise<MirrorBibliographicMetadata | null> {
    if (!doi && !pmid && !pmcid) return null;

    try {
      const rawQuery = doi
        ? `DOI:"${doi}"`
        : pmid
          ? `EXT_ID:${pmid}`
          : `PMC:${pmcid}`;
      const endpoint = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(rawQuery)}&format=json&resultType=core`;

      const signal = AbortSignal.timeout(6000);
      const headers = { Accept: 'application/json' };
      const res = this.httpClient
        ? (
            await this.httpClient.request(endpoint, {
              headers,
              signal,
              timeoutMs: 6000,
            })
          ).response
        : await fetch(endpoint, {
            headers,
            signal,
          });

      if (!res.ok) {
        if (doi) return this.resolveCrossRef(doi);
        return null;
      }

      const data = (await res.json()) as EuropePmcResponse;
      const record = data?.resultList?.result?.[0];
      if (!record || !record.title) {
        if (doi) return this.resolveCrossRef(doi);
        return null;
      }

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
      } else if (record.authorString) {
        authors.push(
          ...record.authorString
            .split(/,\s*(?:and\s+)?/)
            .map((s: string) => s.trim())
            .filter(Boolean),
        );
      }

      let pdfUrl: string | undefined;
      if (Array.isArray(record.fullTextUrlList?.fullTextUrl)) {
        const pdfEntry = record.fullTextUrlList.fullTextUrl.find(
          (u: EuropePmcFullTextUrl) =>
            u.documentStyle === 'pdf' ||
            (typeof u.url === 'string' && u.url.toLowerCase().endsWith('.pdf')),
        );
        if (pdfEntry?.url) {
          pdfUrl = pdfEntry.url;
        }
      }

      const cleanAbstract = record.abstractText
        ? cleanAbstractText(record.abstractText.replace(/<[^>]+>/g, ' '))
        : undefined;

      return {
        title: record.title.replace(/<[^>]+>/g, '').trim(),
        abstract: cleanAbstract,
        authors: authors.length > 0 ? authors : undefined,
        year: record.pubYear ? parseInt(record.pubYear, 10) : undefined,
        doi: record.doi || doi,
        pmid: record.pmid || pmid,
        pmcid: record.pmcid,
        journal:
          record.journalTitle ||
          record.journalInfo?.journal?.title ||
          record.bookOrReportDetails?.publisher,
        isOpenAccess: record.isOpenAccess === 'Y',
        pdfUrl,
        sourceMirror: 'EuropePMC',
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.debug(
        `Open mirror resolution failed for DOI "${doi}" / PMID "${pmid}": ${msg}`,
      );
      if (doi) {
        return this.resolveCrossRef(doi);
      }
      return null;
    }
  }

  /**
   * Free & Open CrossRef Works API mirror resolver (0đ, polite pool).
   * Delegates to CrossRefProvider.
   */
  async resolveCrossRef(
    doi: string,
  ): Promise<MirrorBibliographicMetadata | null> {
    if (!this.crossRefProvider) return null;
    try {
      const targetDoi = doi.replace(/v\d+$/i, '');
      const res = await this.crossRefProvider.resolve(
        { query: targetDoi, queryType: 'DOI' },
        AbortSignal.timeout(6000),
      );
      if (res?.metadata) {
        return this.mapProviderResultToMirror(
          res.metadata as Record<string, unknown>,
          'CrossRef',
          targetDoi,
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.debug(
        `CrossRefProvider resolution failed for DOI "${doi}": ${msg}`,
      );
    }
    return null;
  }

  /**
   * Free & Open arXiv Export API resolver (0đ, polite open mirror).
   * Delegates to ArxivProvider.
   */
  async resolveArxiv(
    arxivId: string,
  ): Promise<MirrorBibliographicMetadata | null> {
    if (!this.arxivProvider) return null;
    try {
      const res = await this.arxivProvider.resolve(
        { query: arxivId, queryType: 'ARXIV' },
        AbortSignal.timeout(6000),
      );
      if (res?.metadata) {
        return this.mapProviderResultToMirror(
          res.metadata as Record<string, unknown>,
          'arXiv',
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.debug(
        `ArxivProvider resolution failed for ID "${arxivId}": ${msg}`,
      );
    }
    return null;
  }

  /**
   * Free & Open OpenAlex Works API resolver (0đ, polite pool).
   * Delegates to OpenAlexProvider.
   */
  async resolveOpenAlex(target: {
    doi?: string;
    pmid?: string;
    pmcid?: string;
    url?: string;
  }): Promise<MirrorBibliographicMetadata | null> {
    if (!this.openAlexProvider) return null;
    try {
      const signal = AbortSignal.timeout(6000);
      const res = target.doi
        ? await this.openAlexProvider.resolve(
            { query: target.doi, queryType: 'DOI' },
            signal,
          )
        : target.pmid
          ? await this.openAlexProvider.resolve(
              { query: target.pmid, queryType: 'PMID' },
              signal,
            )
          : target.pmcid
            ? await this.openAlexProvider.fetchByPmcid(target.pmcid, signal)
            : target.url
              ? await this.openAlexProvider.fetchByUrl(target.url, signal)
              : null;

      if (res?.metadata) {
        return this.mapProviderResultToMirror(
          res.metadata as Record<string, unknown>,
          'OpenAlex',
          target.doi,
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.debug(`OpenAlexProvider resolution failed: ${msg}`);
    }
    return null;
  }
}
