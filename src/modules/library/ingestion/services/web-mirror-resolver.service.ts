import { Injectable, Logger, Optional } from '@nestjs/common';
import { MirrorBibliographicMetadata } from '@/modules/library/ingestion/types/web-fetch.types';
import {
  AcademicHttpClient,
  LibraryConfigService,
  libraryConfig,
  normalizeDoi,
  normalizeArxivId,
  cleanAbstractText,
  cleanBibliographicText,
} from '@/modules/library/core';

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

interface CrossRefAuthor {
  name?: string;
  given?: string;
  family?: string;
}

interface CrossRefDateParts {
  'date-parts'?: number[][];
}

interface CrossRefWork {
  title?: string | string[];
  author?: CrossRefAuthor[];
  'published-print'?: CrossRefDateParts;
  'published-online'?: CrossRefDateParts;
  created?: CrossRefDateParts;
  'container-title'?: string | string[];
  publisher?: string;
  abstract?: string;
  DOI?: string;
}

interface CrossRefResponse {
  message?: CrossRefWork;
}

interface OpenAlexAuthorship {
  author?: { display_name?: string };
}

interface OpenAlexWork {
  title?: string;
  display_name?: string;
  authorships?: OpenAlexAuthorship[];
  primary_location?: {
    source?: { display_name?: string };
    pdf_url?: string;
  };
  host_venue?: { display_name?: string };
  open_access?: {
    oa_url?: string;
    is_oa?: boolean;
  };
  abstract_inverted_index?: Record<string, number[]>;
  publication_year?: number;
  doi?: string;
}

interface OpenAlexResponse extends OpenAlexWork {
  results?: OpenAlexWork[];
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
  ) {}

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
   * Covers 150M+ DOIs across Springer, IEEE, ACM, Nature, Wiley, bioRxiv, arXiv, etc.
   */
  async resolveCrossRef(
    doi: string,
  ): Promise<MirrorBibliographicMetadata | null> {
    try {
      const crossrefMailto =
        this.configService?.providers.crossrefEmail ??
        libraryConfig().providers.crossrefEmail ??
        'contact@flux.academic';
      let targetDoi = doi;
      let endpoint = `https://api.crossref.org/works/${encodeURIComponent(targetDoi)}?mailto=${encodeURIComponent(crossrefMailto)}`;
      const signal = AbortSignal.timeout(6000);
      const headers = { Accept: 'application/json' };
      let res = this.httpClient
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

      // BioRxiv/MedRxiv DOIs in URLs often have version suffix (e.g. 10.1101/2020.03.22.002386v1)
      // which CrossRef indexes under base DOI without version.
      if (!res.ok && /v\d+$/i.test(targetDoi)) {
        targetDoi = targetDoi.replace(/v\d+$/i, '');
        endpoint = `https://api.crossref.org/works/${encodeURIComponent(targetDoi)}?mailto=${encodeURIComponent(crossrefMailto)}`;
        res = this.httpClient
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
      }

      if (!res.ok) return null;

      const data = (await res.json()) as CrossRefResponse;
      const item = data?.message;
      if (!item) return null;

      const rawTitle = Array.isArray(item.title) ? item.title[0] : item.title;
      if (!rawTitle) return null;

      const authors: string[] = [];
      if (Array.isArray(item.author)) {
        for (const a of item.author) {
          if (a.name) {
            authors.push(a.name.trim());
          } else if (a.family) {
            authors.push(`${a.given ? a.given + ' ' : ''}${a.family}`.trim());
          }
        }
      }

      const year =
        item['published-print']?.['date-parts']?.[0]?.[0] ||
        item['published-online']?.['date-parts']?.[0]?.[0] ||
        item['created']?.['date-parts']?.[0]?.[0];

      const journal =
        (Array.isArray(item['container-title'])
          ? item['container-title'][0]
          : item['container-title']) || item.publisher;

      const cleanAbstract = item.abstract
        ? cleanAbstractText(item.abstract.replace(/<[^>]+>/g, ' '))
        : undefined;

      return {
        title: cleanBibliographicText(rawTitle),
        abstract: cleanAbstract,
        authors: authors.length > 0 ? authors : undefined,
        year: typeof year === 'number' ? year : undefined,
        doi: item.DOI || targetDoi,
        journal: journal ? cleanBibliographicText(journal) : undefined,
        isOpenAccess: false,
        sourceMirror: 'CrossRef',
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.debug(
        `Open mirror resolution (CrossRef) failed for DOI "${doi}": ${msg}`,
      );
      return null;
    }
  }

  /**
   * Free & Open arXiv Export API resolver (0đ, polite open mirror).
   */
  async resolveArxiv(
    arxivId: string,
  ): Promise<MirrorBibliographicMetadata | null> {
    try {
      const cleanId = normalizeArxivId(arxivId);
      if (!cleanId) return null;
      const endpoint = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(cleanId)}`;
      const signal = AbortSignal.timeout(6000);
      const res = this.httpClient
        ? (await this.httpClient.request(endpoint, { signal, timeoutMs: 6000 }))
            .response
        : await fetch(endpoint, { signal });
      if (!res.ok) return null;

      const xml = await res.text();
      const titleMatch = xml.match(/<entry>[\s\S]*?<title>([\s\S]*?)<\/title>/);
      const rawTitle = titleMatch?.[1]?.replace(/\s+/g, ' ').trim();
      if (!rawTitle) return null;

      const summaryMatch = xml.match(/<summary>([\s\S]*?)<\/summary>/);
      const rawAbstract = summaryMatch?.[1]?.replace(/\s+/g, ' ').trim();

      const authorMatches = [
        ...xml.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>/g),
      ];
      const authors = authorMatches.map((m) => m[1].trim()).filter(Boolean);

      const pubYearMatch = xml.match(/<published>(\d{4})/);
      const year = pubYearMatch ? parseInt(pubYearMatch[1], 10) : undefined;

      const doiMatch = xml.match(/<arxiv:doi[^>]*>([\s\S]*?)<\/arxiv:doi>/);
      const doi = doiMatch ? doiMatch[1].trim() : `10.48550/arXiv.${cleanId}`;

      return {
        title: cleanBibliographicText(rawTitle),
        abstract: rawAbstract ? cleanAbstractText(rawAbstract) : undefined,
        authors: authors.length > 0 ? authors : undefined,
        year,
        doi,
        journal: 'arXiv',
        isOpenAccess: true,
        sourceMirror: 'arXiv',
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.debug(
        `Open mirror resolution (arXiv) failed for ID "${arxivId}": ${msg}`,
      );
      return null;
    }
  }

  /**
   * Free & Open OpenAlex Works API resolver (0đ, polite pool).
   * Covers 250M+ scientific publications across all publishers, preprints, and open repositories.
   */
  async resolveOpenAlex(target: {
    doi?: string;
    pmid?: string;
    pmcid?: string;
    url?: string;
  }): Promise<MirrorBibliographicMetadata | null> {
    try {
      let endpoint: string;
      const mailto =
        this.configService?.providers.openAlexEmail ??
        libraryConfig().providers.openAlexEmail ??
        'contact@flux.academic';

      if (target.doi) {
        endpoint = `https://api.openalex.org/works/https://doi.org/${encodeURIComponent(target.doi)}?mailto=${encodeURIComponent(mailto)}`;
      } else if (target.pmid) {
        endpoint = `https://api.openalex.org/works/pmid:${encodeURIComponent(target.pmid)}?mailto=${encodeURIComponent(mailto)}`;
      } else if (target.pmcid) {
        endpoint = `https://api.openalex.org/works/pmcid:${encodeURIComponent(target.pmcid)}?mailto=${encodeURIComponent(mailto)}`;
      } else if (target.url) {
        endpoint = `https://api.openalex.org/works?filter=locations.landing_page_url:${encodeURIComponent(target.url)}&mailto=${encodeURIComponent(mailto)}`;
      } else {
        return null;
      }

      const signal = AbortSignal.timeout(6000);
      const headers = {
        Accept: 'application/json',
        'User-Agent': `FluxResearchPlatform/1.0 (mailto:${mailto})`,
      };
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

      if (!res.ok) return null;
      const data = (await res.json()) as OpenAlexResponse;
      const item: OpenAlexWork | undefined = Array.isArray(data.results)
        ? data.results[0]
        : data;
      if (!item || (!item.title && !item.display_name)) return null;

      const rawTitle = item.title || item.display_name || '';
      const authors: string[] = [];
      if (Array.isArray(item.authorships)) {
        for (const auth of item.authorships) {
          if (auth?.author?.display_name) {
            authors.push(auth.author.display_name.trim());
          }
        }
      }

      const primLoc = item.primary_location;
      const journal =
        primLoc?.source?.display_name || item.host_venue?.display_name;
      const pdfUrl = item.open_access?.oa_url || primLoc?.pdf_url;

      let abstract: string | undefined;
      if (
        item.abstract_inverted_index &&
        typeof item.abstract_inverted_index === 'object'
      ) {
        const wordPositions: Array<{ word: string; pos: number }> = [];
        for (const [word, positions] of Object.entries(
          item.abstract_inverted_index,
        )) {
          if (Array.isArray(positions)) {
            for (const pos of positions) {
              wordPositions.push({ word, pos });
            }
          }
        }
        wordPositions.sort((a, b) => a.pos - b.pos);
        abstract = wordPositions
          .map((wp) => wp.word)
          .join(' ')
          .trim();
      }

      return {
        title: cleanBibliographicText(rawTitle),
        abstract: abstract ? cleanAbstractText(abstract) : undefined,
        authors: authors.length > 0 ? authors : undefined,
        year:
          typeof item.publication_year === 'number'
            ? item.publication_year
            : undefined,
        doi: normalizeDoi(item.doi) || target.doi,
        journal: journal ? cleanBibliographicText(journal) : undefined,
        isOpenAccess: Boolean(item.open_access?.is_oa),
        pdfUrl: pdfUrl || undefined,
        sourceMirror: 'OpenAlex',
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.debug(`OpenAlex mirror resolution failed: ${msg}`);
      return null;
    }
  }
}
