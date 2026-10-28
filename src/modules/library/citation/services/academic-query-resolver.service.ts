import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  Optional,
  Inject,
} from '@nestjs/common';
import { ReferenceData } from '@/modules/library/citation/types/citation.types';
import {
  normalizeWork,
  RawCslWorkInput,
} from '@/modules/library/citation/domain/citation.domain';
import {
  AcademicHttpClient,
  METADATA_PORT,
  normalizeDoi,
} from '@/modules/library/core';
import { DoiContentNegotiationService } from './doi-content-negotiation.service';
import { normalizeAcademicTags } from '@/modules/library/core/domain/tag.domain';
import {
  getAcademicContactEmail,
  getAcademicUserAgent,
} from '@/modules/library/core/constants/academic-client.constants';

export interface MetadataPortResolveResult {
  metadata?: Record<string, unknown>;
  provenance?: Record<string, { provider?: string }>;
  queryType?: string;
}

@Injectable()
export class AcademicQueryResolverService {
  private readonly logger = new Logger(AcademicQueryResolverService.name);

  constructor(
    @Optional()
    private readonly doiService?: DoiContentNegotiationService,
    @Optional()
    @Inject(METADATA_PORT)
    private readonly metadataPort?: {
      resolve: (req: {
        query: string;
        userId?: string;
      }) => Promise<MetadataPortResolveResult | null | undefined>;
    },
    @Optional()
    private readonly httpClient?: AcademicHttpClient,
  ) {}

  private get crossRefMailto(): string {
    return getAcademicContactEmail();
  }

  private async executeHttpGet(
    url: string,
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<Response> {
    if (this.httpClient) {
      const { response } = await this.httpClient.request(url, {
        headers,
        signal,
        timeoutMs: 8000,
      });
      return response;
    }
    return fetch(url, {
      headers,
      signal,
    });
  }

  /**
   * Resolves a DOI via unified MetadataPort first, falling back to CrossRef API.
   */
  async resolveDoi(rawDoi: string): Promise<ReferenceData> {
    const clean = rawDoi
      .trim()
      .replace(/^https?:\/\/doi\.org\//i, '')
      .replace(/^doi:/i, '');
    if (!clean) {
      throw new BadRequestException('Invalid DOI provided');
    }

    if (this.metadataPort) {
      try {
        const resolved = await this.metadataPort.resolve({ query: clean });
        if (
          resolved?.metadata &&
          (resolved.metadata.title || resolved.metadata.doi)
        ) {
          return this.mapItemMetadataToReferenceData(resolved.metadata);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.debug(
          `MetadataPort DOI resolution fallback for "${clean}": ${message}`,
        );
      }
    }

    try {
      const mailto = this.crossRefMailto;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const url = `https://api.crossref.org/works/${encodeURIComponent(clean)}?mailto=${encodeURIComponent(mailto)}`;
      const headers = {
        Accept: 'application/json',
        'User-Agent': getAcademicUserAgent('Citation'),
      };
      const res = await this.executeHttpGet(url, headers, controller.signal);
      clearTimeout(timeout);

      if (!res.ok) {
        throw new NotFoundException(
          `DOI not found on CrossRef (${res.status})`,
        );
      }

      const json = (await res.json()) as {
        message?: Parameters<
          AcademicQueryResolverService['mapCrossRefMessage']
        >[0];
      } | null;
      const message = json?.message ?? {};
      return this.mapCrossRefMessage(message);
    } catch (err: unknown) {
      if (
        err instanceof NotFoundException ||
        err instanceof BadRequestException
      )
        throw err;
      const errMsg = err instanceof Error ? err.message : String(err);
      throw new BadRequestException(`Failed to resolve DOI: ${errMsg}`);
    }
  }

  /**
   * Searches CrossRef API for references matching query.
   */
  async searchCrossRef(
    query: string,
    rows: number = 5,
  ): Promise<{ works: ReferenceData[]; totalResults: number }> {
    if (!query?.trim()) {
      return { works: [], totalResults: 0 };
    }

    try {
      const mailto = this.crossRefMailto;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const url = `https://api.crossref.org/works?query=${encodeURIComponent(query.trim())}&rows=${rows}&mailto=${encodeURIComponent(mailto)}`;
      const headers = {
        Accept: 'application/json',
        'User-Agent': getAcademicUserAgent('Citation'),
      };
      const res = await this.executeHttpGet(url, headers, controller.signal);
      clearTimeout(timeout);

      if (!res.ok) {
        return { works: [], totalResults: 0 };
      }

      const json = (await res.json()) as {
        message?: {
          items?: Array<
            Parameters<AcademicQueryResolverService['mapCrossRefMessage']>[0]
          >;
          'total-results'?: number;
        };
      } | null;
      const items = json?.message?.items || [];
      const totalResults = json?.message?.['total-results'] ?? items.length;
      const works = items.map((item) => this.mapCrossRefMessage(item));
      return { works, totalResults };
    } catch {
      return { works: [], totalResults: 0 };
    }
  }

  public mapItemMetadataToReferenceData(
    metadata: Record<string, unknown>,
  ): ReferenceData {
    let authors: string[] = [];
    if (Array.isArray(metadata.authors) && metadata.authors.length > 0) {
      authors = metadata.authors as string[];
    } else if (
      Array.isArray(metadata.creators) &&
      metadata.creators.length > 0
    ) {
      authors = (
        metadata.creators as Array<{
          name?: string;
          firstName?: string;
          lastName?: string;
        }>
      )
        .map((c) => {
          if (c.name) return c.name;
          const parts = [c.firstName, c.lastName].filter(Boolean);
          return parts.join(' ');
        })
        .filter(Boolean);
    }

    let year: number | string | undefined =
      (metadata.year as number | string) ?? undefined;
    if (
      !year &&
      (typeof metadata.publicationDate === 'string' ||
        typeof metadata.publicationDate === 'number')
    ) {
      const pubDateStr = String(metadata.publicationDate);
      const yearMatch = pubDateStr.match(/\b(\d{4})\b/);
      if (yearMatch) {
        year = parseInt(yearMatch[1], 10);
      } else {
        const parsedYear = new Date(pubDateStr).getUTCFullYear();
        if (!isNaN(parsedYear)) {
          year = parsedYear;
        }
      }
    }

    const combinedTags = normalizeAcademicTags([
      ...((metadata.keywords as string[]) || []),
      ...((metadata.tags as string[]) || []),
    ]);

    const doiStr =
      typeof metadata.doi === 'string' && metadata.doi.trim()
        ? metadata.doi.trim()
        : undefined;

    return {
      doi: doiStr,
      title: (metadata.title as string) || '',
      authors: authors.length > 0 ? authors : undefined,
      creators: (
        metadata.creators as
          | Array<{
              creatorType?: string;
              name?: string;
              firstName?: string;
              lastName?: string;
            }>
          | undefined
      )?.map((c) => ({
        creatorType: c.creatorType || 'author',
        name:
          c.name || [c.firstName, c.lastName].filter(Boolean).join(' ').trim(),
        firstName: c.firstName ?? undefined,
        lastName: c.lastName ?? undefined,
      })),
      year,
      journal: (metadata.journal || metadata.publicationTitle) as
        string | undefined,
      publicationTitle: (metadata.publicationTitle || metadata.journal) as
        string | undefined,
      publicationDate: (metadata.publicationDate || metadata.date) as
        string | undefined,
      publisher: metadata.publisher as string | undefined,
      volume: metadata.volume as string | undefined,
      issue: metadata.issue as string | undefined,
      pages: metadata.pages as string | undefined,
      issn: metadata.issn as string | undefined,
      isbn: metadata.isbn as string | undefined,
      arxivId: metadata.arxivId as string | undefined,
      pmid: metadata.pmid as string | undefined,
      pmcid: metadata.pmcid as string | undefined,
      url:
        (metadata.url as string | undefined) ||
        (metadata.openAccessPdfUrl as string | undefined) ||
        (doiStr ? `https://doi.org/${doiStr}` : undefined),
      openAccessPdfUrl: (metadata.openAccessPdfUrl || metadata.pdfUrl) as
        string | undefined,
      abstract: (metadata.abstract || metadata.abstractNote) as
        string | undefined,
      citationCount: metadata.citationCount as number | undefined,
      keywords: combinedTags,
      tags: combinedTags,
      type:
        (metadata.type as string | undefined) ||
        (metadata.itemType as string | undefined) ||
        'journal-article',
      itemType:
        (metadata.itemType as string | undefined) ||
        (metadata.type as string | undefined) ||
        'journalArticle',
      extraFields: metadata.extraFields as Record<string, unknown> | undefined,
      provenance: metadata.provenance as Record<string, unknown> | undefined,
    };
  }

  /**
   * Intelligently resolves academic queries (DOI, arXiv ID, PMID, ISBN, URL, or title/keyword search).
   * Gracefully returns { found: false, ... } without throwing 404 exceptions on misses.
   */
  async resolveAcademicQuery(
    rawQuery: string,
    rawDoi?: string,
    userId?: string,
  ): Promise<{
    found: boolean;
    work: ReferenceData | null;
    provider: string;
    queryType:
      | 'doi'
      | 'arxiv'
      | 'title'
      | 'pmid'
      | 'isbn'
      | 'url'
      | 'unknown'
      | (string & {});
  }> {
    const input = (rawDoi || rawQuery || '').trim();
    if (!input) {
      return {
        found: false,
        work: null,
        provider: 'CrossRef',
        queryType: 'unknown',
      };
    }

    // 1. Attempt resolution via the 7-provider unified MetadataPort pipeline
    if (this.metadataPort) {
      try {
        const resolved = await this.metadataPort.resolve({
          query: input,
          userId,
        });

        if (
          resolved?.metadata &&
          (resolved.metadata.title || resolved.metadata.doi)
        ) {
          const work = this.mapItemMetadataToReferenceData(resolved.metadata);
          const firstProv = Object.values(resolved.provenance || {})[0] as
            { provider?: string } | undefined;
          const primaryProvider =
            resolved.provenance?.title?.provider ||
            resolved.provenance?.doi?.provider ||
            firstProv?.provider ||
            'AcademicMetadata';

          return {
            found: true,
            work,
            provider: primaryProvider,
            queryType: (resolved.queryType || 'unknown').toLowerCase(),
          };
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.debug(
          `MetadataPort resolution failed for "${input}": ${message}`,
        );
      }
    }

    // 2. DOI Fallback
    const cleanDoiCandidate = normalizeDoi(input) || input.trim();

    const isDoi = this.doiService
      ? this.doiService.isDoi(cleanDoiCandidate)
      : Boolean(normalizeDoi(cleanDoiCandidate));

    if (isDoi) {
      try {
        const work = await this.resolveDoi(cleanDoiCandidate);
        return {
          found: true,
          work,
          provider: 'CrossRef',
          queryType: 'doi',
        };
      } catch {
        if (this.doiService) {
          try {
            const cslWork =
              await this.doiService.resolveMetadata(cleanDoiCandidate);
            if (cslWork && cslWork.title && cslWork.title !== 'Untitled') {
              return {
                found: true,
                work: cslWork,
                provider: 'doi.org/DataCite',
                queryType: 'doi',
              };
            }
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.debug(
              `DOI Content Negotiation failed for "${cleanDoiCandidate}": ${message}`,
            );
          }
        }
      }

      return {
        found: false,
        work: null,
        provider: 'CrossRef',
        queryType: 'doi',
      };
    }

    // 3. Title / Keyword Search via CrossRef
    try {
      const searchRes = await this.searchCrossRef(input, 1);
      if (searchRes.works && searchRes.works.length > 0) {
        const topWork = searchRes.works[0];
        return {
          found: true,
          work: topWork,
          provider: 'CrossRef',
          queryType: 'title',
        };
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.debug(
        `CrossRef search failed for query "${input}": ${message}`,
      );
    }

    return {
      found: false,
      work: null,
      provider: 'CrossRef',
      queryType: 'title',
    };
  }

  public mapCrossRefMessage(
    message: RawCslWorkInput | null | undefined,
  ): ReferenceData {
    return normalizeWork(message);
  }
}
