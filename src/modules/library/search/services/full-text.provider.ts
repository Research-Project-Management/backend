import { Injectable, Optional } from '@nestjs/common';
import { SearchRepository } from '../repositories/search.repository';
import { SubsystemUnavailableException } from '@/modules/library/core/errors/domain.exception';

export interface PageTextExtraction {
  pageIndex: number;
  textContent: string;
  charOffset?: number;
}

export interface PageAnchorMatch {
  attachmentId: string;
  pageIndex: number;
  snippet: string;
  charOffsetStart: number;
  charOffsetEnd: number;
}

@Injectable()
export class FullTextProvider {
  private readonly repo: SearchRepository;

  constructor(@Optional() private readonly searchRepo?: SearchRepository) {
    if (!this.searchRepo) {
      throw new SubsystemUnavailableException(
        'FullTextProvider requires SearchRepository',
        { service: 'SearchIndex' },
      );
    }
    this.repo = this.searchRepo;
  }

  /**
   * Indexes pages of an attachment for deep full-text search and page anchor retrieval.
   */
  async indexAttachmentPages(
    attachmentId: string,
    pages: PageTextExtraction[],
  ): Promise<void> {
    await this.repo.replaceAttachmentPageIndex(attachmentId, pages);
  }

  /**
   * Searches within indexed pages of an attachment and returns exact page anchors and snippet offsets.
   */
  async searchPageAnchors(
    attachmentId: string,
    term: string,
    pageIndex?: number,
  ): Promise<PageAnchorMatch[]> {
    const normalizedTerm = (term ?? '').trim().toLowerCase();
    if (!normalizedTerm) return [];

    const pages = await this.repo.findAttachmentPages(
      attachmentId,
      pageIndex,
      normalizedTerm,
    );
    const matches: PageAnchorMatch[] = [];

    for (const page of pages) {
      const textContent = page.textContent || '';
      const lower = textContent.toLowerCase();
      let pos = 0;

      while ((pos = lower.indexOf(normalizedTerm, pos)) !== -1) {
        const charOffsetStart = (page.charOffset ?? 0) + pos;
        const charOffsetEnd = charOffsetStart + normalizedTerm.length;

        // Generate surrounding contextual snippet (60 chars before/after)
        const snippetStart = Math.max(0, pos - 60);
        const snippetEnd = Math.min(
          textContent.length,
          pos + normalizedTerm.length + 60,
        );
        const snippet = textContent
          .substring(snippetStart, snippetEnd)
          .replace(/\s+/g, ' ')
          .trim();

        matches.push({
          attachmentId,
          pageIndex: page.pageIndex,
          snippet,
          charOffsetStart,
          charOffsetEnd,
        });

        pos += normalizedTerm.length;
      }
    }

    return matches;
  }
}
