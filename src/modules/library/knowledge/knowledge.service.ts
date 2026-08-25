import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { CatalogRepository } from '../catalog/catalog.repository';
import { CatalogExtraStore } from '../catalog/catalog-extra.store';
import { LinkKnowledgeItemDto } from './dto/knowledge.dto';
import {
  StoredRelation,
  RelatedKnowledgeItem,
  LibraryKnowledgeGraph,
  GraphNode,
  GraphEdge,
} from './types/knowledge.types';
import { isSelfRelation, toRelationPairKey } from './knowledge.util';

@Injectable()
export class KnowledgeService {
  constructor(
    private readonly catalogRepo: CatalogRepository,
    private readonly extraStore: CatalogExtraStore,
  ) {}

  /**
   * Get all items related to a specific item.
   */
  async getRelatedPapers(
    workspaceId: string,
    paperId: string,
  ): Promise<{ relatedPapers: RelatedKnowledgeItem[]; total: number }> {
    const paper = await this.resolvePaper(workspaceId, paperId);

    const relations = await this.extraStore.getRelations(paper.id);
    if (relations.length === 0) {
      return { relatedPapers: [], total: 0 };
    }

    const targetIds = relations
      .map((r) => r.targetItemId || r.targetPaperId || '')
      .filter(Boolean);

    const targetPapers = await this.catalogRepo.findItems({
      id: { in: targetIds },
      workspaceId: paper.workspaceId,
      deletedAt: null,
    });

    const targetMap = new Map(targetPapers.map((p) => [p.id, p]));

    const relatedPapers: RelatedKnowledgeItem[] = relations.flatMap((rel) => {
      const targetId = rel.targetItemId || rel.targetPaperId || '';
      const target = targetMap.get(targetId);
      if (!target) return [];
      return [
        {
          id: target.id,
          title: target.title,
          authors: target.authors || [],
          year: target.year || null,
          citationKey: target.citationKey || '',
          relationType: rel.type,
          note: rel.note,
          linkedAt: rel.linkedAt,
        } satisfies RelatedKnowledgeItem,
      ];
    });

    return { relatedPapers, total: relatedPapers.length };
  }

  /**
   * Alias for getRelatedPapers
   */
  async getRelatedItems(workspaceId: string, itemId: string) {
    return this.getRelatedPapers(workspaceId, itemId);
  }

  /**
   * Create a symmetric bi-directional semantic link between two items (concurrency-safe).
   */
  async linkPapers(
    workspaceId: string,
    sourcePaperId: string,
    dto: LinkKnowledgeItemDto,
  ): Promise<{ success: boolean; link: StoredRelation }> {
    const targetWsId = await this.catalogRepo.resolveWorkspaceId(workspaceId);
    const targetItemId = dto.targetItemId || dto.targetPaperId || '';

    if (!targetItemId) {
      throw new BadRequestException('Target item ID is required');
    }

    if (isSelfRelation(sourcePaperId, targetItemId)) {
      throw new BadRequestException('Cannot link an item to itself');
    }

    const [source, target] = await Promise.all([
      this.catalogRepo.findItemByIdInWorkspace(targetWsId, sourcePaperId),
      this.catalogRepo.findItemByIdInWorkspace(targetWsId, targetItemId),
    ]);

    if (!source || source.deletedAt) {
      throw new NotFoundException('Source item not found in this workspace');
    }
    if (!target || target.deletedAt) {
      throw new NotFoundException('Target item not found in this workspace');
    }

    const now = new Date().toISOString();
    const relationType = dto.relationType || 'related';

    const sourceLink: StoredRelation = {
      targetItemId,
      targetPaperId: targetItemId,
      type: relationType,
      note: dto.note || undefined,
      linkedAt: now,
    };

    // Symmetric update — both sides stored atomically in their own extra
    await Promise.all([
      this.extraStore.putRelation(sourcePaperId, sourceLink),
      this.extraStore.putRelation(targetItemId, {
        targetItemId: sourcePaperId,
        targetPaperId: sourcePaperId,
        type: relationType,
        note: dto.note || undefined,
        linkedAt: now,
      }),
    ]);

    return { success: true, link: sourceLink };
  }

  /**
   * Alias for linkPapers
   */
  async linkItems(
    workspaceId: string,
    sourceItemId: string,
    dto: LinkKnowledgeItemDto,
  ) {
    return this.linkPapers(workspaceId, sourceItemId, dto);
  }

  /**
   * Remove a symmetric bi-directional link between two items (concurrency-safe).
   */
  async unlinkPapers(
    workspaceId: string,
    sourcePaperId: string,
    targetPaperId: string,
  ): Promise<{ success: boolean }> {
    const targetWsId = await this.catalogRepo.resolveWorkspaceId(workspaceId);

    const [source, target] = await Promise.all([
      this.catalogRepo.findItemByIdInWorkspace(targetWsId, sourcePaperId),
      this.catalogRepo.findItemByIdInWorkspace(targetWsId, targetPaperId),
    ]);

    if (!source || source.deletedAt) {
      throw new NotFoundException('Source item not found in this workspace');
    }
    if (!target || target.deletedAt) {
      throw new NotFoundException('Target item not found in this workspace');
    }

    await Promise.all([
      this.extraStore.removeRelation(sourcePaperId, targetPaperId),
      this.extraStore.removeRelation(targetPaperId, sourcePaperId),
    ]);

    return { success: true };
  }

  /**
   * Alias for unlinkPapers
   */
  async unlinkItems(
    workspaceId: string,
    sourceItemId: string,
    targetItemId: string,
  ) {
    return this.unlinkPapers(workspaceId, sourceItemId, targetItemId);
  }

  /**
   * Alias for getKnowledgeGraph (for controller)
   */
  async getWorkspaceKnowledgeGraph(
    workspaceId: string,
  ): Promise<LibraryKnowledgeGraph> {
    return this.getKnowledgeGraph(workspaceId);
  }

  /**
   * Build complete Knowledge Graph for the workspace.
   */
  async getKnowledgeGraph(workspaceId: string): Promise<LibraryKnowledgeGraph> {
    const targetWsId = await this.catalogRepo.resolveWorkspaceId(workspaceId);

    const papers = await this.catalogRepo.findItems({
      workspaceId: targetWsId,
      deletedAt: null,
    });

    const nodes: GraphNode[] = papers.map((p) => ({
      id: p.id,
      label: p.title,
      citationKey: p.citationKey || '',
      year: p.year || null,
      authors: p.authors || [],
    }));

    const edges: GraphEdge[] = [];
    const seenEdges = new Set<string>();

    const relationsMap = await this.extraStore.getBulkRelations(
      papers.map((p) => p.id),
    );

    for (const p of papers) {
      const relations = relationsMap.get(p.id) ?? [];
      for (const rel of relations) {
        const targetId = rel.targetItemId || rel.targetPaperId || '';
        if (!targetId) continue;
        const edgeKey = toRelationPairKey(p.id, targetId);
        if (!seenEdges.has(edgeKey)) {
          seenEdges.add(edgeKey);
          edges.push({
            source: p.id,
            target: targetId,
            relationType: rel.type,
            note: rel.note,
          });
        }
      }
    }

    return {
      nodes,
      edges,
      totalNodes: nodes.length,
      totalEdges: edges.length,
    };
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private async resolvePaper(workspaceId: string, paperId: string) {
    const targetWsId = await this.catalogRepo.resolveWorkspaceId(workspaceId);

    const paper = await this.catalogRepo.findItemByIdInWorkspace(
      targetWsId,
      paperId,
    );
    if (!paper || paper.deletedAt) {
      throw new NotFoundException('Catalog item not found in this workspace');
    }
    return paper;
  }
}
