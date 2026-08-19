import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PaperRepository } from '../paper/paper.repository';
import { LinkPaperDto } from './dto/relation.dto';
import {
  StoredRelation,
  RelatedPaperItem,
  LibraryKnowledgeGraph,
  GraphNode,
  GraphEdge,
} from './types/relation.types';

@Injectable()
export class RelationService {
  private readonly logger = new Logger(RelationService.name);

  constructor(private readonly paperRepo: PaperRepository) {}

  private parseStoredRelations(extraString: string | null): StoredRelation[] {
    if (!extraString || !extraString.trim()) return [];
    try {
      const parsed = JSON.parse(extraString);
      if (Array.isArray(parsed.relations)) {
        return parsed.relations;
      }
    } catch {}
    return [];
  }

  private serializeRelations(
    existingExtra: string | null,
    relations: StoredRelation[],
  ): string {
    let baseObj: Record<string, any> = {};
    if (existingExtra && existingExtra.trim()) {
      try {
        baseObj = JSON.parse(existingExtra);
      } catch {}
    }
    baseObj.relations = relations;
    return JSON.stringify(baseObj);
  }

  /**
   * Get all papers related to a specific paper
   */
  async getRelatedPapers(
    workspaceId: string,
    paperId: string,
  ): Promise<{ relatedPapers: RelatedPaperItem[]; total: number }> {
    const ws = await this.paperRepo.resolveWorkspace(workspaceId);
    const targetWsId = ws?.id || workspaceId;

    const paper = await this.paperRepo.findPaperById(paperId);
    if (!paper || paper.deletedAt || paper.workspaceId !== targetWsId) {
      throw new NotFoundException('Paper not found in this workspace');
    }

    const relations = this.parseStoredRelations(paper.extra);
    if (relations.length === 0) {
      return { relatedPapers: [], total: 0 };
    }

    const targetIds = relations.map((r) => r.targetPaperId);
    const targetPapers = await this.paperRepo.findPapers({
      id: { in: targetIds },
      workspaceId: targetWsId,
      deletedAt: null,
    });

    const targetMap = new Map<string, (typeof targetPapers)[0]>();
    targetPapers.forEach((p) => targetMap.set(p.id, p));

    const relatedPapers: RelatedPaperItem[] = [];
    for (const rel of relations) {
      const target = targetMap.get(rel.targetPaperId);
      if (target) {
        relatedPapers.push({
          id: target.id,
          title: target.title,
          authors: target.authors || [],
          year: target.year || null,
          citationKey: target.citationKey || '',
          relationType: rel.type,
          note: rel.note,
          linkedAt: rel.linkedAt,
        });
      }
    }

    return {
      relatedPapers,
      total: relatedPapers.length,
    };
  }

  /**
   * Create a symmetric bi-directional link between two papers
   */
  async linkPapers(
    workspaceId: string,
    sourcePaperId: string,
    dto: LinkPaperDto,
  ): Promise<{ success: boolean; link: StoredRelation }> {
    const ws = await this.paperRepo.resolveWorkspace(workspaceId);
    const targetWsId = ws?.id || workspaceId;

    if (sourcePaperId === dto.targetPaperId) {
      throw new BadRequestException('A paper cannot be linked to itself');
    }

    const [source, target] = await Promise.all([
      this.paperRepo.findPaperById(sourcePaperId),
      this.paperRepo.findPaperById(dto.targetPaperId),
    ]);

    if (!source || source.deletedAt || source.workspaceId !== targetWsId) {
      throw new NotFoundException('Source paper not found in this workspace');
    }
    if (!target || target.deletedAt || target.workspaceId !== targetWsId) {
      throw new NotFoundException('Target paper not found in this workspace');
    }

    const now = new Date().toISOString();
    const relationType = dto.relationType || 'related';

    // 1. Update source paper relations
    const sourceRelations = this.parseStoredRelations(source.extra).filter(
      (r) => r.targetPaperId !== dto.targetPaperId,
    );
    const newSourceLink: StoredRelation = {
      targetPaperId: dto.targetPaperId,
      type: relationType,
      note: dto.note || undefined,
      linkedAt: now,
    };
    sourceRelations.push(newSourceLink);
    const updatedSourceExtra = this.serializeRelations(
      source.extra,
      sourceRelations,
    );

    // 2. Update target paper relations (symmetric link)
    const targetRelations = this.parseStoredRelations(target.extra).filter(
      (r) => r.targetPaperId !== sourcePaperId,
    );
    const newTargetLink: StoredRelation = {
      targetPaperId: sourcePaperId,
      type: relationType,
      note: dto.note || undefined,
      linkedAt: now,
    };
    targetRelations.push(newTargetLink);
    const updatedTargetExtra = this.serializeRelations(
      target.extra,
      targetRelations,
    );

    // Persist both
    await Promise.all([
      this.paperRepo.updatePaper(sourcePaperId, { extra: updatedSourceExtra }),
      this.paperRepo.updatePaper(dto.targetPaperId, {
        extra: updatedTargetExtra,
      }),
    ]);

    return {
      success: true,
      link: newSourceLink,
    };
  }

  /**
   * Remove a symmetric bi-directional link between two papers
   */
  async unlinkPapers(
    workspaceId: string,
    sourcePaperId: string,
    targetPaperId: string,
  ): Promise<{ success: boolean }> {
    const ws = await this.paperRepo.resolveWorkspace(workspaceId);
    const targetWsId = ws?.id || workspaceId;

    const [source, target] = await Promise.all([
      this.paperRepo.findPaperById(sourcePaperId),
      this.paperRepo.findPaperById(targetPaperId),
    ]);

    if (source && source.workspaceId === targetWsId) {
      const sourceRelations = this.parseStoredRelations(source.extra).filter(
        (r) => r.targetPaperId !== targetPaperId,
      );
      const updatedSourceExtra = this.serializeRelations(
        source.extra,
        sourceRelations,
      );
      await this.paperRepo.updatePaper(sourcePaperId, {
        extra: updatedSourceExtra,
      });
    }

    if (target && target.workspaceId === targetWsId) {
      const targetRelations = this.parseStoredRelations(target.extra).filter(
        (r) => r.targetPaperId !== sourcePaperId,
      );
      const updatedTargetExtra = this.serializeRelations(
        target.extra,
        targetRelations,
      );
      await this.paperRepo.updatePaper(targetPaperId, {
        extra: updatedTargetExtra,
      });
    }

    return { success: true };
  }

  /**
   * Constructs the full knowledge graph for the entire workspace library
   */
  async getWorkspaceKnowledgeGraph(
    workspaceId: string,
  ): Promise<LibraryKnowledgeGraph> {
    const ws = await this.paperRepo.resolveWorkspace(workspaceId);
    const targetWsId = ws?.id || workspaceId;

    const papers = await this.paperRepo.findPapers({
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

    for (const p of papers) {
      const relations = this.parseStoredRelations(p.extra);
      for (const rel of relations) {
        // Create an undirected sorted key to avoid duplicate reverse edges
        const edgeKey = [p.id, rel.targetPaperId].sort().join('___');
        if (!seenEdges.has(edgeKey)) {
          seenEdges.add(edgeKey);
          edges.push({
            source: p.id,
            target: rel.targetPaperId,
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
}
