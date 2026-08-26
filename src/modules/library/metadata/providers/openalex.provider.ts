import { Injectable, Logger } from '@nestjs/common';
import { getErrorMessage, tryCatch } from '@/core/utils/error.util';

import { UnifiedAcademicMetadata } from '../types/metadata.types';
import { normalizeDoi, validateAcademicMetadata } from '../utils/metadata.util';

import { createHash } from 'crypto';

@Injectable()
export class OpenAlexProvider {
  private readonly logger = new Logger(OpenAlexProvider.name);
  private readonly BASE_URL = 'https://api.openalex.org/works';

  /**
   * Fetch work by DOI or OpenAlex ID
   */
  async fetchByDoi(doi: string): Promise<UnifiedAcademicMetadata | null> {
    if (!doi) return null;
    const cleanDoi = normalizeDoi(doi) || doi.trim();
    const url = `${this.BASE_URL}/https://doi.org/${encodeURIComponent(cleanDoi)}?mailto=contact@flux.academic`;

    const responseResult = await tryCatch(
      fetch(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent':
            'FluxResearchPlatform/1.0 (mailto:contact@flux.academic; https://flux.study)',
        },
        signal: AbortSignal.timeout(8000),
      }),
    );

    if (!responseResult.ok || !responseResult.value.ok) return null;

    const jsonResult = await tryCatch(responseResult.value.json());
    if (!jsonResult.ok || !jsonResult.value) return null;

    return this.transformPayload(jsonResult.value);
  }

  /**
   * Search top matching work by Title
   */
  async searchByTitle(title: string): Promise<UnifiedAcademicMetadata | null> {
    if (!title) return null;

    const url = `${this.BASE_URL}?search=${encodeURIComponent(title)}&per-page=1&mailto=contact@flux.academic`;
    const responseResult = await tryCatch(
      fetch(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent':
            'FluxResearchPlatform/1.0 (mailto:contact@flux.academic; https://flux.study)',
        },
        signal: AbortSignal.timeout(8000),
      }),
    );

    if (!responseResult.ok || !responseResult.value.ok) return null;

    const jsonResult = await tryCatch(responseResult.value.json());
    if (
      !jsonResult.ok ||
      !jsonResult.value ||
      !jsonResult.value.results ||
      jsonResult.value.results.length === 0
    ) {
      return null;
    }

    return this.transformPayload(jsonResult.value.results[0]);
  }

  transformPayload(data: any): UnifiedAcademicMetadata {
    const authors: string[] = [];
    if (Array.isArray(data.authorships)) {
      for (const a of data.authorships) {
        if (a.author?.display_name) {
          authors.push(a.author.display_name);
        }
      }
    }

    const rawDoi = normalizeDoi(data.doi || data.ids?.doi);

    // Invert OpenAlex inverted index abstract if available
    let abstract: string | undefined = undefined;
    if (data.abstract_inverted_index) {
      const words: [number, string][] = [];
      for (const [word, positions] of Object.entries(
        data.abstract_inverted_index,
      )) {
        if (Array.isArray(positions)) {
          for (const pos of positions as number[]) {
            words.push([pos, word]);
          }
        }
      }
      words.sort((a, b) => a[0] - b[0]);
      abstract = words.map((w) => w[1]).join(' ');
    }

    const journal =
      data.primary_location?.source?.display_name ||
      data.host_venue?.display_name ||
      undefined;

    const publisher =
      data.primary_location?.source?.host_organization_name ||
      data.host_venue?.publisher ||
      undefined;

    const keywords: string[] = [];
    if (Array.isArray(data.concepts)) {
      for (const c of data.concepts.slice(0, 8)) {
        if (c?.display_name && !keywords.includes(c.display_name)) {
          keywords.push(c.display_name);
        }
      }
    }
    if (Array.isArray(data.topics)) {
      for (const t of data.topics.slice(0, 4)) {
        if (t?.display_name && !keywords.includes(t.display_name)) {
          keywords.push(t.display_name);
        }
      }
    }

    const isOpenAccess = Boolean(data.open_access?.is_oa);
    const openAccessPdfUrl = data.open_access?.oa_url || undefined;
    const rawSnapshotHash = createHash('md5')
      .update(JSON.stringify(data))
      .digest('hex');

    const result: UnifiedAcademicMetadata = {
      title: data.title || data.display_name || 'Untitled',
      authors,
      year: data.publication_year ? Number(data.publication_year) : null,
      doi: rawDoi,
      journal,
      publisher,
      volume: data.biblio?.volume || undefined,
      issue: data.biblio?.issue || undefined,
      pages: data.biblio?.first_page
        ? data.biblio.last_page
          ? `${data.biblio.first_page}–${data.biblio.last_page}`
          : data.biblio.first_page
        : undefined,
      abstract,
      keywords: keywords.length ? keywords : undefined,
      citationCount:
        typeof data.cited_by_count === 'number'
          ? data.cited_by_count
          : undefined,
      openAccessPdfUrl,
      itemType:
        data.type === 'journal-article'
          ? 'journalArticle'
          : data.type === 'book'
            ? 'book'
            : 'journalArticle',
      url: rawDoi ? `https://doi.org/${rawDoi}` : data.id || undefined,
      provenance: {
        originProvider: 'OpenAlex',
        resolvedAt: new Date().toISOString(),
        canonicalId: rawDoi ? `doi:${rawDoi}` : data.id || 'openalex:unknown',
        canonicalUrl: rawDoi ? `https://doi.org/${rawDoi}` : data.id,
        confidenceScore: 0.95,
        rawSnapshotHash,
        isOpenAccess,
        openAccessPdfUrl,
      },
    };

    return validateAcademicMetadata(result) || result;
  }
}
