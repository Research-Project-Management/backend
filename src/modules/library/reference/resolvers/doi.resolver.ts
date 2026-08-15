import { Injectable, Logger } from '@nestjs/common';
import { getErrorMessage, tryCatch } from '@/core/utils/error.util';

export interface ResolvedDoiMetadata {
  doi: string;
  title: string;
  authors: string[];
  year: number | null;
  journal?: string;
  publisher?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  issn?: string;
  isbn?: string;
  url?: string;
  abstract?: string;
  itemType: string;
}

@Injectable()
export class DoiResolver {
  private readonly logger = new Logger(DoiResolver.name);

  /**
   * Cleans raw DOI strings (strips https://doi.org/ or doi:)
   */
  cleanDoi(rawDoi: string): string {
    if (!rawDoi || typeof rawDoi !== 'string') return '';
    return rawDoi
      .trim()
      .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
      .replace(/^doi:\s*/i, '');
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
            'ResearchManagement/1.0 (mailto:admin@research-management.local)',
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

    const message = jsonResult.value.message;

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
        : message.type || 'journalArticle';

    return {
      doi,
      title,
      authors,
      year,
      journal,
      publisher: message.publisher,
      volume: message.volume,
      issue: message.issue,
      pages: message.page,
      issn: Array.isArray(message.ISSN) ? message.ISSN[0] : message.ISSN,
      isbn: Array.isArray(message.ISBN) ? message.ISBN[0] : message.ISBN,
      url: message.URL || `https://doi.org/${doi}`,
      abstract: message.abstract
        ? message.abstract.replace(/<[^>]*>/g, '')
        : undefined,
      itemType,
    };
  }
}
