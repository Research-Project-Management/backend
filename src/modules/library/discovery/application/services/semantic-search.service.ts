import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../../../../core/database/prisma.service';
import { LocalEmbeddingService } from './local-embedding.service';
import { VectorIndexService } from './vector-index.service';
import {
  SemanticSearchDto,
  SemanticSearchResponse,
  SemanticSearchResultItem,
} from '../dtos/semantic-search.dto';

@Injectable()
export class SemanticSearchService {
  private readonly logger = new Logger(SemanticSearchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly embedding: LocalEmbeddingService,
    private readonly vectorIndex: VectorIndexService,
  ) {}

  private async getScopeWhere(userId: string, projectId?: string) {
    if (projectId && projectId !== 'user') {
      const member = await this.prisma.projectMember.findUnique({
        where: {
          projectId_userId: { projectId, userId },
        },
        select: { id: true },
      });
      if (!member) {
        throw new ForbiddenException(
          `Access denied: You are not a member of project ${projectId}`,
        );
      }
      return { projectId, deletedAt: null };
    }
    return { userId, deletedAt: null };
  }

  /**
   * Performs semantic vector search across a user's library items.
   */
  async searchSemantic(
    userId: string,
    dto: SemanticSearchDto,
  ): Promise<SemanticSearchResponse> {
    const start = Date.now();
    const scopeWhere = await this.getScopeWhere(userId, dto.projectId);

    // 1. Fetch active library items for the user/project scope
    const items = await this.prisma.item.findMany({
      where: scopeWhere,
      select: {
        id: true,
        title: true,
        year: true,
        doi: true,
        itemType: true,
        publicationTitle: true,
        abstract: true,
        contributors: {
          select: { fullName: true },
          orderBy: { orderIndex: 'asc' },
        },
      },
    });

    if (items.length === 0) {
      return {
        results: [],
        total: 0,
        query: dto.query,
        executionTimeMs: Date.now() - start,
      };
    }

    // 2. Embed the search query
    const queryVector = await this.embedding.embedText(dto.query);

    // 3. Find semantically closest items using in-memory vector index
    const candidateIds = items.map((i) => i.id);
    const limit = dto.limit ?? 10;
    const threshold = dto.threshold ?? 0.25;

    const matches = await this.vectorIndex.searchSimilar(
      queryVector,
      candidateIds,
      limit,
      threshold,
    );

    // 4. Map matches back to rich item details
    const itemsMap = new Map(items.map((i) => [i.id, i]));
    const results: SemanticSearchResultItem[] = [];

    for (const match of matches) {
      const item = itemsMap.get(match.itemId);
      if (!item) continue;

      results.push({
        id: item.id,
        title: item.title,
        year: item.year,
        doi: item.doi,
        itemType: item.itemType,
        publicationTitle: item.publicationTitle,
        abstract: item.abstract,
        similarityScore: Number(match.similarityScore.toFixed(4)),
        authors: item.contributors.map((c) => c.fullName),
      });
    }

    return {
      results,
      total: results.length,
      query: dto.query,
      executionTimeMs: Date.now() - start,
    };
  }

  /**
   * Finds semantically related items ("More like this") for a specific paper.
   */
  async findRelatedItems(
    userId: string,
    itemId: string,
    limit = 5,
    projectId?: string,
  ): Promise<SemanticSearchResultItem[]> {
    const scopeWhere = await this.getScopeWhere(userId, projectId);

    // 1. Verify target item exists
    const targetItem = await this.prisma.item.findFirst({
      where: { id: itemId, ...scopeWhere },
      include: {
        contributors: {
          select: { fullName: true },
          orderBy: { orderIndex: 'asc' },
        },
      },
    });

    if (!targetItem) {
      throw new NotFoundException(`Item ${itemId} not found`);
    }

    // 2. Get or generate target vector
    let targetVector = await this.vectorIndex.getVector(itemId);
    if (!targetVector) {
      targetVector = await this.indexItem(targetItem);
    }

    // 3. Fetch all other candidate items in the library
    const candidates = await this.prisma.item.findMany({
      where: {
        ...scopeWhere,
        id: { not: itemId },
      },
      select: {
        id: true,
        title: true,
        year: true,
        doi: true,
        itemType: true,
        publicationTitle: true,
        abstract: true,
        contributors: {
          select: { fullName: true },
          orderBy: { orderIndex: 'asc' },
        },
      },
    });

    if (candidates.length === 0) {
      return [];
    }

    // 4. Find closest items
    const candidateIds = candidates.map((c) => c.id);
    const matches = await this.vectorIndex.searchSimilar(
      targetVector,
      candidateIds,
      limit,
      0.2, // slightly lower threshold for recommendations
    );

    const candidatesMap = new Map(candidates.map((c) => [c.id, c]));
    const results: SemanticSearchResultItem[] = [];

    for (const match of matches) {
      const item = candidatesMap.get(match.itemId);
      if (!item) continue;

      results.push({
        id: item.id,
        title: item.title,
        year: item.year,
        doi: item.doi,
        itemType: item.itemType,
        publicationTitle: item.publicationTitle,
        abstract: item.abstract,
        similarityScore: Number(match.similarityScore.toFixed(4)),
        authors: item.contributors.map((c) => c.fullName),
      });
    }

    return results;
  }

  /**
   * Generates and stores the semantic vector for a single library item.
   */
  async indexItem(item: {
    id: string;
    title: string;
    abstract?: string | null;
    publicationTitle?: string | null;
    contributors?: Array<{ fullName: string }>;
  }): Promise<Float32Array> {
    const authors = item.contributors?.map((c) => c.fullName).join(', ') || '';
    const textToEmbed = [
      item.title,
      authors ? `Authors: ${authors}` : '',
      item.publicationTitle ? `Journal: ${item.publicationTitle}` : '',
      item.abstract || '',
    ]
      .filter(Boolean)
      .join('\n\n');

    const vector = await this.embedding.embedText(textToEmbed);
    await this.vectorIndex.saveVector(item.id, vector);

    this.logger.debug(`Item ${item.id} indexed into local vector store.`);
    return vector;
  }

  /**
   * Batch indexes all unindexed papers in a user or project library.
   */
  async indexLibrary(
    userId: string,
    projectId?: string,
  ): Promise<{ indexed: number; total: number }> {
    const scopeWhere = await this.getScopeWhere(userId, projectId);

    const items = await this.prisma.item.findMany({
      where: scopeWhere,
      include: {
        contributors: { select: { fullName: true } },
      },
    });

    let indexed = 0;
    for (const item of items) {
      try {
        await this.indexItem(item);
        indexed++;
      } catch (err: any) {
        this.logger.warn(`Failed to index item ${item.id}: ${err?.message}`);
      }
    }

    this.logger.log(
      `Indexed ${indexed}/${items.length} items in local vector index.`,
    );
    return { indexed, total: items.length };
  }
}
