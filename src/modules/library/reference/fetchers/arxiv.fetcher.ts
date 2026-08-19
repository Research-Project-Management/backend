import { Injectable, Logger } from '@nestjs/common';
import { getErrorMessage, tryCatch } from '@/core/utils/error.util';
import { UnifiedAcademicMetadata } from './types/fetcher.types';

@Injectable()
export class ArxivFetcher {
  private readonly logger = new Logger(ArxivFetcher.name);
  private readonly BASE_URL = 'https://export.arxiv.org/api/query';

  /**
   * Fetch preprint metadata directly from arXiv API
   */
  async fetchById(arxivId: string): Promise<UnifiedAcademicMetadata | null> {
    if (!arxivId) return null;

    const cleanId = arxivId.replace(/^arxiv:\s*/i, '').trim();
    const url = `${this.BASE_URL}?id_list=${encodeURIComponent(cleanId)}&max_results=1`;

    const responseResult = await tryCatch(
      fetch(url, {
        headers: {
          'User-Agent': 'ResearchManagement/1.0 (academic-research-bot)',
        },
        signal: AbortSignal.timeout(8000),
      }),
    );

    if (!responseResult.ok || !responseResult.value.ok) {
      this.logger.warn(`arXiv fetch failed for ${arxivId}`);
      return null;
    }

    const xmlResult = await tryCatch(responseResult.value.text());
    if (!xmlResult.ok || !xmlResult.value) return null;

    const xml = xmlResult.value;

    // Check if entry exists
    if (!xml.includes('<entry>') || xml.includes('<entry>\n    <id>http://arxiv.org/api/errors/')) {
      return null;
    }

    const titleMatch = xml.match(/<title>([\s\S]*?)<\/title>/gi);
    // index 0 is feed title, index 1 is entry title
    const entryTitle = titleMatch && titleMatch[1]
      ? titleMatch[1].replace(/<\/?title>/gi, '').replace(/\s+/g, ' ').trim()
      : 'Untitled arXiv Preprint';

    const summaryMatch = xml.match(/<summary>([\s\S]*?)<\/summary>/i);
    const abstract = summaryMatch && summaryMatch[1]
      ? summaryMatch[1].replace(/\s+/g, ' ').trim()
      : undefined;

    const publishedMatch = xml.match(/<published>(\d{4})-\d{2}-\d{2}/i);
    const year = publishedMatch && publishedMatch[1] ? Number(publishedMatch[1]) : null;

    const authors: string[] = [];
    const authorMatches = xml.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>\s*<\/author>/gi);
    for (const m of authorMatches) {
      if (m[1]) {
        authors.push(m[1].trim());
      }
    }

    const doiMatch = xml.match(/<arxiv:doi[^>]*>([\s\S]*?)<\/arxiv:doi>/i);
    const doi = doiMatch && doiMatch[1] ? doiMatch[1].trim() : undefined;

    return {
      title: entryTitle,
      authors,
      year,
      arxivId: cleanId,
      doi,
      journal: 'arXiv preprint',
      abstract,
      openAccessPdfUrl: `https://arxiv.org/pdf/${cleanId}.pdf`,
      itemType: 'preprint',
      url: `https://arxiv.org/abs/${cleanId}`,
    };
  }
}
