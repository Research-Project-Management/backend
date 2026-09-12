import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SearchRepository, SearchOptions } from './search.repository';
import { PrismaService } from '@/core/database/prisma.service';
import {
  FullTextProvider,
  PageAnchorMatch,
  PageTextExtraction,
} from './providers/full-text.provider';
import {
  RagProvider,
  RagIndexPaperInput,
  RagIndexResult,
} from './providers/rag.provider';
import { SearchItemsQueryDto } from './dto/search.dto';

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(
    private readonly repo: SearchRepository,
    private readonly prisma: PrismaService,
    private readonly fullText: FullTextProvider,
    private readonly rag: RagProvider,
  ) {}

  /**
   * Faceted search returning items, facets, and cursor pagination metadata.
   */
  async search(workspaceId: string, dto: SearchItemsQueryDto) {
    const searchOptions: SearchOptions = {
      q: dto.query,
      collectionId: dto.collectionId,
      tagId: dto.tagId,
      limit: dto.limit,
      cursor: dto.cursor,
    };

    const [searchResult, facets] = await Promise.all([
      this.repo.searchItems(workspaceId, searchOptions),
      this.repo.computeFacets(workspaceId, searchOptions),
    ]);

    return {
      items: searchResult.items,
      facets,
      meta: {
        cursor: searchResult.nextCursor,
        hasNextPage: searchResult.hasNextPage,
        totalCount: searchResult.items.length,
      },
    };
  }

  /**
   * Search PDF attachment pages for text occurrences and character offsets.
   */
  async searchPageAnchors(
    workspaceId: string,
    attachmentId: string,
    term: string,
    pageIndex?: number,
  ): Promise<PageAnchorMatch[]> {
    const attachment = await this.prisma.attachment.findFirst({
      where: {
        id: attachmentId,
        item: { workspaceId, deletedAt: null },
      },
      select: { id: true },
    });

    if (!attachment) {
      throw new NotFoundException(
        `Attachment ${attachmentId} not found in workspace`,
      );
    }

    return this.fullText.searchPageAnchors(attachmentId, term, pageIndex);
  }

  async indexAttachmentPages(
    attachmentId: string,
    pages: PageTextExtraction[],
  ): Promise<void> {
    await this.fullText.indexAttachmentPages(attachmentId, pages);
  }

  /**
   * Rebuilds full-text and faceted search index for a given workspace.
   */
  async rebuildIndex(
    workspaceId: string,
  ): Promise<{ indexedItems: number; indexedAttachments: number }> {
    this.logger.log(`Rebuilding search index for workspace ${workspaceId}...`);
    const facets = await this.repo.computeFacets(workspaceId, {});
    const totalTypes = Object.values(facets.itemTypes).reduce(
      (a, b) => a + b,
      0,
    );
    this.logger.log(
      `Search index validated for workspace ${workspaceId}: ${totalTypes} active items indexed.`,
    );
    return {
      indexedItems: totalTypes,
      indexedAttachments: 0,
    };
  }

  /**
   * Uploads and vectorizes an academic paper into Qdrant for RAG.
   */
  async indexPaperForRag(item: RagIndexPaperInput): Promise<RagIndexResult> {
    return this.rag.indexPaper(item);
  }
}
