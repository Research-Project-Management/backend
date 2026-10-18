import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  Optional,
  Inject,
} from '@nestjs/common';
import { ReferenceData } from '@/modules/library/citation/types/citation.types';
import { AcademicHttpClient } from '@/modules/library/core';
import { DoiContentNegotiationService } from './doi-content-negotiation.service';
import { normalizeTags } from '@/modules/library/core/domain/tag.domain';
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
    @Inject('METADATA_PORT')
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

  /**
   * Resolves a DOI via CrossRef API.
   */
  async resolveDoi(rawDoi: string): Promise<ReferenceData> {
    const clean = rawDoi
      .trim()
      .replace(/^https?:\/\/doi\.org\//i, '')
      .replace(/^doi:/i, '');
    if (!clean) {
      throw new BadRequestException('Invalid DOI provided');
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
      const res = this.httpClient
        ? (
            await this.httpClient.request(url, {
              headers,
              signal: controller.signal,
              timeoutMs: 8000,
            })
          ).response
        : await fetch(url, {
            headers,
            signal: controller.signal,
          });
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
      const res = this.httpClient
        ? (
            await this.httpClient.request(url, {
              headers,
              signal: controller.signal,
              timeoutMs: 8000,
            })
          ).response
        : await fetch(url, {
            headers,
            signal: controller.signal,
          });
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

    const combinedTags = normalizeTags([
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
    data: ReferenceData | null;
    metadata: ReferenceData | null;
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
        data: null,
        metadata: null,
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
            data: work,
            metadata: work,
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
    const cleanDoiCandidate = this.doiService
      ? this.doiService.cleanDoi(input) || input
      : input
          .replace(/^https?:\/\/doi\.org\//i, '')
          .replace(/^https?:\/\/dx\.doi\.org\//i, '')
          .replace(/^doi:\s*/i, '')
          .trim();

    const isDoi = this.doiService
      ? this.doiService.isDoi(cleanDoiCandidate)
      : /^10\.\d{4,9}\/[-._;()/:A-Za-z0-9<>+=[\]~]+$/i.test(cleanDoiCandidate);

    if (isDoi) {
      try {
        const work = await this.resolveDoi(cleanDoiCandidate);
        return {
          found: true,
          work,
          data: work,
          metadata: work,
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
                data: cslWork,
                metadata: cslWork,
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
        data: null,
        metadata: null,
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
          data: topWork,
          metadata: topWork,
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
      data: null,
      metadata: null,
      provider: 'CrossRef',
      queryType: 'title',
    };
  }

  public mapCrossRefMessage(
    message:
      | {
          title?: string | string[];
          author?: Array<{ given?: string; family?: string; name?: string }>;
          'published-print'?: { 'date-parts'?: (number | string)[][] };
          'published-online'?: { 'date-parts'?: (number | string)[][] };
          issued?: { 'date-parts'?: (number | string)[][] };
          DOI?: string;
          'container-title'?: string | string[];
          publisher?: string;
          volume?: string;
          issue?: string;
          page?: string;
          ISSN?: string | string[];
          ISBN?: string | string[];
          URL?: string;
          abstract?: string;
          type?: string;
          score?: number;
        }
      | null
      | undefined,
  ): ReferenceData {
    const title = Array.isArray(message?.title)
      ? message.title[0] || 'Untitled'
      : message?.title || 'Untitled';
    const authors: string[] = [];
    if (Array.isArray(message?.author)) {
      for (const auth of message.author) {
        if (auth.given && auth.family)
          authors.push(`${auth.family}, ${auth.given}`);
        else if (auth.family) authors.push(auth.family);
        else if (auth.name) authors.push(auth.name);
      }
    }
    let year: number | string = '';
    const dateParts =
      message?.['published-print']?.['date-parts']?.[0] ||
      message?.['published-online']?.['date-parts']?.[0] ||
      message?.issued?.['date-parts']?.[0];
    if (dateParts && dateParts[0]) year = Number(dateParts[0]);

    return {
      doi: message?.DOI || '',
      title,
      authors,
      year,
      journal: Array.isArray(message?.['container-title'])
        ? message['container-title'][0]
        : message?.['container-title'] || '',
      publisher: message?.publisher || '',
      volume: message?.volume || '',
      issue: message?.issue || '',
      pages: message?.page || '',
      issn: Array.isArray(message?.ISSN)
        ? message.ISSN[0]
        : message?.ISSN || '',
      isbn: Array.isArray(message?.ISBN)
        ? message.ISBN[0]
        : message?.ISBN || '',
      url:
        message?.URL || (message?.DOI ? `https://doi.org/${message.DOI}` : ''),
      abstract: message?.abstract
        ? message.abstract.replace(/<[^>]*>/g, '')
        : '',
      type: message?.type || 'journal-article',
      itemType:
        message?.type === 'journal-article'
          ? 'journalArticle'
          : message?.type || 'journalArticle',
      score: message?.score || 0,
    };
  }
}
