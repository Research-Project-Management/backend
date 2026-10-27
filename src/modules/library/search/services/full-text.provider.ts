import { Injectable, Optional } from '@nestjs/common';
import { SearchRepository } from '../repositories/search.repository';
import {
  SubsystemUnavailableException,
  isSafeSearchRegex,
  parseSafeSearchRegex,
} from '@/modules/library/core';

export { isSafeSearchRegex, parseSafeSearchRegex };

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
   * Supports both case-insensitive substring matching and safe `/pattern/flags` regular expressions.
   */
  async searchPageAnchors(
    attachmentId: string,
    term: string,
    pageIndex?: number,
  ): Promise<PageAnchorMatch[]> {
    const trimmedTerm = (term ?? '').trim();
    const safeRegex = parseSafeSearchRegex(trimmedTerm);
    const normalizedTerm = trimmedTerm.toLowerCase();
    if (!safeRegex && normalizedTerm.length < 2) return [];

    const MAX_MATCHES_PER_ATTACHMENT = 200;
    const MAX_MATCHES_PER_PAGE = 50;

    const pages = await this.repo.findAttachmentPages(
      attachmentId,
      pageIndex,
      safeRegex ? undefined : normalizedTerm,
    );
    const matches: PageAnchorMatch[] = [];

    for (const page of pages) {
      const textContent = page.textContent || '';
      let pageMatches = 0;

      if (safeRegex) {
        safeRegex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while (
          (match = safeRegex.exec(textContent)) !== null &&
          matches.length < MAX_MATCHES_PER_ATTACHMENT &&
          pageMatches < MAX_MATCHES_PER_PAGE
        ) {
          const matchedText = match[0] || '';
          if (matchedText.length === 0) {
            safeRegex.lastIndex++;
            continue;
          }
          pageMatches++;
          const pos = match.index;
          const charOffsetStart = (page.charOffset ?? 0) + pos;
          const charOffsetEnd = charOffsetStart + matchedText.length;

          const snippetStart = Math.max(0, pos - 60);
          const snippetEnd = Math.min(
            textContent.length,
            pos + matchedText.length + 60,
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
        }
      } else {
        const lower = textContent.toLowerCase();
        let pos = 0;

        while (
          (pos = lower.indexOf(normalizedTerm, pos)) !== -1 &&
          matches.length < MAX_MATCHES_PER_ATTACHMENT &&
          pageMatches < MAX_MATCHES_PER_PAGE
        ) {
          pageMatches++;
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

      if (matches.length >= MAX_MATCHES_PER_ATTACHMENT) break;
    }

    return matches;
  }
}
