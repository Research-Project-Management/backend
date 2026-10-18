import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core';

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
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Indexes pages of an attachment for deep full-text search and page anchor retrieval.
   */
  async indexAttachmentPages(
    attachmentId: string,
    pages: PageTextExtraction[],
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // Delete existing index for this attachment
      await tx.fullTextIndex.deleteMany({
        where: { attachmentId },
      });

      // Batch insert new page indexes atomically
      if (pages.length > 0) {
        await tx.fullTextIndex.createMany({
          data: pages.map((page) => ({
            attachmentId,
            pageIndex: page.pageIndex,
            textContent: (page.textContent || '').replace(/\0/g, ''),
            charOffset: page.charOffset ?? 0,
          })),
        });
      }
    });
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

    const dbPages = await this.prisma.fullTextIndex.findMany({
      where: {
        attachmentId,
        ...(pageIndex !== undefined ? { pageIndex } : {}),
      },
      orderBy: { pageIndex: 'asc' },
    });

    const pages: PageTextExtraction[] = dbPages.map((dbPage) => ({
      pageIndex: dbPage.pageIndex,
      textContent: dbPage.textContent || '',
      charOffset: dbPage.charOffset,
    }));

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
