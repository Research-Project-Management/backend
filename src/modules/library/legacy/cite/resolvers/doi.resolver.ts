import { Injectable, Logger } from '@nestjs/common';
import { getErrorMessage, tryCatch } from '@/core/utils/error.util';
import { ProvenanceMetadata } from '@/modules/library/legacy/metadata/types/metadata.types';
import { normalizeDoi } from '@/modules/library/legacy/metadata/utils/metadata.util';

import { createHash } from 'crypto';

export interface ResolvedDoiMetadata {
  doi: string;
  title: string;
  authors: string[];
  year: number | null;
  publicationDate?: string;
  journal?: string;
  journalAbbr?: string;
  publisher?: string;
  place?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  series?: string;
  issn?: string;
  isbn?: string;
  url?: string;
  license?: string;
  abstract?: string;
  keywords?: string[];
  itemType: string;
  provenance?: ProvenanceMetadata;
}

@Injectable()
export class DoiResolver {
  private readonly logger = new Logger(DoiResolver.name);

  /**
   * Cleans raw DOI strings (strips https://doi.org/ or doi:)
   */
  cleanDoi(rawDoi: string): string {
    if (!rawDoi || typeof rawDoi !== 'string') return '';
    return (
      normalizeDoi(rawDoi) ||
      rawDoi
        .trim()
        .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
        .replace(/^doi:\s*/i, '')
        .trim()
    );
  }

  /**
   * Resolves academic metadata via CrossRef REST API
   */
  async resolve(rawDoi: string): Promise<ResolvedDoiMetadata | null> {
    const doi = this.cleanDoi(rawDoi);
    if (!doi) return null;

    const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
    const responseResult = await tryCatch(
      fetch(url, {
        headers: {
          'User-Agent':
            'FluxResearchPlatform/1.0 (mailto:contact@flux.academic; https://flux.study)',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(8000),
      }),
    );

    if (!responseResult.ok) {
      this.logger.warn(
        `Failed to resolve DOI ${doi}: ${getErrorMessage(responseResult.error)}`,
      );
      return null;
    }

    const response = responseResult.value;
    if (!response.ok) {
      this.logger.warn(
        `CrossRef API returned status ${response.status} for DOI: ${doi}`,
      );
      return null;
    }

    const jsonResult = await tryCatch(
      response.json() as Promise<{ message?: Record<string, any> }>,
    );

    if (!jsonResult.ok || !jsonResult.value.message) {
      return null;
    }

    return this.transformMessage(jsonResult.value.message, doi);
  }

  /**
   * Search academic literature by Title via CrossRef bibliographic search
   */
  async searchByTitle(title: string): Promise<ResolvedDoiMetadata | null> {
    if (!title || !title.trim()) return null;

    const url = `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(title.trim())}&rows=1&mailto=contact@flux.academic`;
    const responseResult = await tryCatch(
      fetch(url, {
        headers: {
          'User-Agent':
            'FluxResearchPlatform/1.0 (mailto:contact@flux.academic; https://flux.study)',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(8000),
      }),
    );

    if (!responseResult.ok || !responseResult.value.ok) {
      return null;
    }

    const jsonResult = await tryCatch(
      responseResult.value.json() as Promise<{
        message?: { items?: Record<string, any>[] };
      }>,
    );

    if (!jsonResult.ok || !jsonResult.value.message?.items?.length) {
      return null;
    }

    const item = jsonResult.value.message.items[0];
    const doi = item.DOI || '';
    return this.transformMessage(item, doi);
  }

  private transformMessage(
    message: Record<string, any>,
    doi: string,
  ): ResolvedDoiMetadata {
    const title = Array.isArray(message.title)
      ? message.title[0] || 'Untitled'
      : message.title || 'Untitled';

    const authors: string[] = [];
    if (Array.isArray(message.author)) {
      for (const auth of message.author) {
        if (auth.given && auth.family) {
          authors.push(`${auth.family}, ${auth.given}`);
        } else if (auth.family) {
          authors.push(auth.family);
        } else if (auth.name) {
          authors.push(auth.name);
        }
      }
    }

    let year: number | null = null;
    const dateParts =
      message['published-print']?.['date-parts']?.[0] ||
      message['published-online']?.['date-parts']?.[0] ||
      message.issued?.['date-parts']?.[0];
    if (dateParts && dateParts[0]) {
      year = Number(dateParts[0]);
    }

    const journal = Array.isArray(message['container-title'])
      ? message['container-title'][0]
      : message['container-title'] || undefined;

    const itemType =
      message.type === 'journal-article'
        ? 'journalArticle'
        : message.type === 'proceedings-article'
          ? 'conferencePaper'
          : message.type === 'book'
            ? 'book'
            : message.type || 'journalArticle';

    const keywords: string[] = [];
    if (Array.isArray(message.subject)) {
      keywords.push(...message.subject.filter(Boolean));
    }

    const journalAbbr = Array.isArray(message['short-container-title'])
      ? message['short-container-title'][0]
      : message['short-container-title'] || undefined;

    const series = Array.isArray(message['collection-title'])
      ? message['collection-title'][0]
      : message['collection-title'] || undefined;

    const place = message['publisher-location'] || undefined;

    let publicationDate: string | undefined;
    if (dateParts && dateParts.length) {
      publicationDate = dateParts
        .map((p: any) => String(p).padStart(2, '0'))
        .join('-');
    }

    const license =
      Array.isArray(message.license) && message.license[0]?.URL
        ? message.license[0].URL
        : undefined;

    const rawSnapshotHash = createHash('md5')
      .update(JSON.stringify(message))
      .digest('hex');

    return {
      doi,
      title,
      authors,
      year,
      publicationDate,
      journal,
      journalAbbr,
      publisher: message.publisher,
      place,
      volume: message.volume,
      issue: message.issue,
      pages: message.page,
      series,
      issn: Array.isArray(message.ISSN) ? message.ISSN[0] : message.ISSN,
      isbn: Array.isArray(message.ISBN) ? message.ISBN[0] : message.ISBN,
      url: message.URL || (doi ? `https://doi.org/${doi}` : undefined),
      license,
      abstract: message.abstract
        ? message.abstract.replace(/<[^>]*>/g, '').trim()
        : undefined,
      keywords: keywords.length ? keywords : undefined,
      itemType,
      provenance: {
        originProvider: 'CrossRef',
        resolvedAt: new Date().toISOString(),
        canonicalId: doi ? `doi:${doi}` : `crossref:${title}`,
        canonicalUrl:
          message.URL || (doi ? `https://doi.org/${doi}` : undefined),
        confidenceScore: 0.95,
        rawSnapshotHash,
        isOpenAccess: Boolean(
          message.link?.some(
            (l: any) => l['content-type'] === 'application/pdf',
          ),
        ),
      },
    };
  }
}
