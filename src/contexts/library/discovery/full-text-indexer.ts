import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../core/database/prisma.service';

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
export class FullTextIndexer {
  private readonly logger = new Logger(FullTextIndexer.name);
  private readonly memIndex = new Map<string, PageTextExtraction[]>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Indexes pages of an attachment for deep full-text search and page anchor retrieval.
   */
  async indexAttachmentPages(
    attachmentId: string,
    pages: PageTextExtraction[],
  ): Promise<void> {
    try {
      // Delete existing index for this attachment
      await this.prisma.fullTextIndex.deleteMany({
        where: { attachmentId },
      });

      // Batch insert new page indexes
      await this.prisma.fullTextIndex.createMany({
        data: pages.map((p) => ({
          attachmentId,
          pageIndex: p.pageIndex,
          textContent: p.textContent,
          charOffset: p.charOffset ?? 0,
        })),
      });
    } catch {
      // In-memory fallback
      this.memIndex.set(attachmentId, pages);
    }
  }

  /**
   * Searches within indexed pages of an attachment and returns exact page anchors and snippet offsets.
   */
  async searchPageAnchors(
    attachmentId: string,
    term: string,
    pageIndex?: number,
  ): Promise<PageAnchorMatch[]> {
    const normalizedTerm = term.trim().toLowerCase();
    if (!normalizedTerm) return [];

    let pages: PageTextExtraction[] = [];

    try {
      const dbPages = await this.prisma.fullTextIndex.findMany({
        where: {
          attachmentId,
          ...(pageIndex !== undefined ? { pageIndex } : {}),
        },
        orderBy: { pageIndex: 'asc' },
      });

      pages = dbPages.map((p) => ({
        pageIndex: p.pageIndex,
        textContent: p.textContent,
        charOffset: p.charOffset,
      }));
    } catch {
      pages = this.memIndex.get(attachmentId) ?? [];
      if (pageIndex !== undefined) {
        pages = pages.filter((p) => p.pageIndex === pageIndex);
      }
    }

    const matches: PageAnchorMatch[] = [];

    for (const page of pages) {
      const lower = page.textContent.toLowerCase();
      let pos = 0;

      while ((pos = lower.indexOf(normalizedTerm, pos)) !== -1) {
        const charOffsetStart = (page.charOffset ?? 0) + pos;
        const charOffsetEnd = charOffsetStart + normalizedTerm.length;

        // Generate surrounding contextual snippet (60 chars before/after)
        const snippetStart = Math.max(0, pos - 60);
        const snippetEnd = Math.min(
          page.textContent.length,
          pos + normalizedTerm.length + 60,
        );
        const snippet = page.textContent.substring(snippetStart, snippetEnd);

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
