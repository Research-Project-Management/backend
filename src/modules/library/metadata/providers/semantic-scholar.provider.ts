import { Injectable, Logger } from '@nestjs/common';
import { getErrorMessage, tryCatch } from '../../../../core/utils/error.util';
import { UnifiedAcademicMetadata } from '../types/metadata.types';

@Injectable()
export class SemanticScholarProvider {
  private readonly logger = new Logger(SemanticScholarProvider.name);
  private readonly BASE_URL = 'https://api.semanticscholar.org/graph/v1/paper';
  private readonly FIELDS =
    'title,authors,year,venue,publicationVenue,abstract,tldr,citationCount,openAccessPdf,externalIds,fieldsOfStudy,publicationTypes';

  /**
   * Fetch by paper identifier (DOI, arXiv, CorpusId, S2Id, or URL)
   */
  async fetchById(paperId: string): Promise<UnifiedAcademicMetadata | null> {
    if (!paperId) return null;

    let cleanId = paperId.trim();
    if (cleanId.startsWith('10.')) {
      cleanId = `DOI:${cleanId}`;
    } else if (/^\d{4}\.\d{4,5}/i.test(cleanId)) {
      const bareArxiv = cleanId.replace(/v\d+$/i, '');
      cleanId = `ARXIV:${bareArxiv}`;
    }

    const url = `${this.BASE_URL}/${encodeURIComponent(cleanId)}?fields=${this.FIELDS}`;

    const responseResult = await tryCatch(
      fetch(url, {
        headers: {
          'User-Agent':
            'ResearchManagementPlatform/1.0 (mailto:admin@researchmanagement.local; academic-research-bot)',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(8000),
      }),
    );

    if (!responseResult.ok) {
      this.logger.warn(
        `S2 fetch error for ${paperId}: ${getErrorMessage(responseResult.error)}`,
      );
      return null;
    }

    const response = responseResult.value;
    if (!response.ok) {
      return null;
    }

    const jsonResult = await tryCatch(response.json());
    if (!jsonResult.ok || !jsonResult.value || !jsonResult.value.title) {
      return null;
    }

    return this.transformPayload(jsonResult.value);
  }

  /**
   * Search top matching paper by title
   */
  async searchByTitle(title: string): Promise<UnifiedAcademicMetadata | null> {
    if (!title) return null;

    const url = `${this.BASE_URL}/search?query=${encodeURIComponent(title)}&limit=1&fields=${this.FIELDS}`;
    const responseResult = await tryCatch(
      fetch(url, {
        headers: {
          'User-Agent':
            'ResearchManagementPlatform/1.0 (mailto:admin@researchmanagement.local; academic-research-bot)',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(8000),
      }),
    );

    if (!responseResult.ok || !responseResult.value.ok) return null;

    const jsonResult = await tryCatch(responseResult.value.json());
    if (
      !jsonResult.ok ||
      !jsonResult.value.data ||
      jsonResult.value.data.length === 0
    ) {
      return null;
    }

    return this.transformPayload(jsonResult.value.data[0]);
  }

  private transformPayload(data: any): UnifiedAcademicMetadata {
    const authors = Array.isArray(data.authors)
      ? data.authors.map((a: any) => a.name).filter(Boolean)
      : [];

    const externalIds = data.externalIds || {};
    const doi = externalIds.DOI || undefined;
    const arxivId = externalIds.ArXiv || undefined;

    let itemType = 'journalArticle';
    if (Array.isArray(data.publicationTypes)) {
      if (
        data.publicationTypes.includes('Conference') ||
        data.publicationTypes.includes('ConferencePaper')
      ) {
        itemType = 'conferencePaper';
      } else if (data.publicationTypes.includes('Book')) {
        itemType = 'book';
      }
    }

    const canonicalId = doi
      ? `doi:${doi}`
      : arxivId
        ? `arxiv:${arxivId}`
        : data.paperId || 's2:unknown';
    const isOpenAccess = Boolean(data.openAccessPdf?.url || arxivId);
    const openAccessPdfUrl =
      data.openAccessPdf?.url ||
      (arxivId ? `https://arxiv.org/pdf/${arxivId}.pdf` : undefined);

    const keywords: string[] = [];
    if (Array.isArray(data.fieldsOfStudy)) {
      keywords.push(...data.fieldsOfStudy.filter(Boolean));
    }
    if (Array.isArray(data.s2FieldsOfStudy)) {
      for (const f of data.s2FieldsOfStudy) {
        if (f?.category && !keywords.includes(f.category)) {
          keywords.push(f.category);
        }
      }
    }

    return {
      title: data.title || 'Untitled',
      authors,
      year: data.year || null,
      doi,
      arxivId,
      journal: data.venue || data.publicationVenue?.name || undefined,
      abstract: data.abstract || undefined,
      tldr: data.tldr?.text || undefined,
      keywords: keywords.length ? keywords : undefined,
      citationCount:
        typeof data.citationCount === 'number' ? data.citationCount : undefined,
      openAccessPdfUrl,
      itemType,
      url: doi
        ? `https://doi.org/${doi}`
        : arxivId
          ? `https://arxiv.org/abs/${arxivId}`
          : undefined,
      provenance: {
        originProvider: 'SemanticScholar',
        resolvedAt: new Date().toISOString(),
        canonicalId,
        canonicalUrl: doi
          ? `https://doi.org/${doi}`
          : arxivId
            ? `https://arxiv.org/abs/${arxivId}`
            : undefined,
        confidenceScore: doi || arxivId ? 1.0 : 0.85,
        isOpenAccess,
        openAccessPdfUrl,
      },
    };
  }
}
