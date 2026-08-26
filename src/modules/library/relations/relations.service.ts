import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ItemsRepository } from '../items/items.repository';

import {
  StoredRelation,
  RelatedItem,
  RelationGraph,
  GraphNode,
  GraphEdge,
  RelationType,
} from './types/relations.types';
import { isSelfRelation, toRelationPairKey } from './utils/relations.util';

export interface LinkRelatedItemInput {
  targetItemId?: string;
  relationType?: string;
  note?: string;
}

export interface LinkDirectedItemInput {
  targetItemId: string;
  relationType?: string;
  description?: string;
}

@Injectable()
export class RelationsService {
  constructor(private readonly catalogRepo: ItemsRepository) {}

  /**
   * Get all items related to a specific item.
   */
  async getRelatedItems(
    workspaceId: string,
    itemId: string,
  ): Promise<{
    relatedItems: RelatedItem[];
    relatedPapers: RelatedItem[];
    total: number;
  }> {
    const item = await this.resolveItem(workspaceId, itemId);

    const relations = await this.catalogRepo.getRelations(item.id);
    if (relations.length === 0) {
      return { relatedItems: [], relatedPapers: [], total: 0 };
    }

    const targetIds = relations
      .map((r) => r.targetPaperId || r.targetItemId || '')
      .filter(Boolean);

    const targetItems = await this.catalogRepo.findItems({
      id: { in: targetIds },
      workspaceId: item.workspaceId,
      deletedAt: null,
    });

    const targetMap = new Map(
      targetItems.map((targetItem) => [targetItem.id, targetItem]),
    );

    const relatedItems: RelatedItem[] = relations.flatMap((rel) => {
      const targetId = rel.targetPaperId || rel.targetItemId || '';
      const target = targetMap.get(targetId);
      if (!target) return [];
      return [
        {
          id: target.id,
          title: target.title,
          authors: target.authors || [],
          year: target.year || null,
          itemType: target.itemType || undefined,
          citationKey: target.citationKey || undefined,
          relationType: (rel.type || rel.relationType || 'related') as any,
          note: rel.note || rel.description,
          linkedAt: rel.linkedAt || rel.createdAt,
        },
      ];
    });

    return {
      relatedItems,
      relatedPapers: relatedItems,
      total: relatedItems.length,
    };
  }

  /**
   * Link two items symmetrically in item.extra.
   */
  async linkItems(
    workspaceId: string,
    sourceItemId: string,
    dto: LinkRelatedItemInput,
    _userId?: string,
  ): Promise<{ success: boolean; link: any; message: string }> {
    const targetId = dto.targetItemId || '';
    if (!targetId) {
      throw new BadRequestException('Target paper or item ID is required');
    }

    if (isSelfRelation(sourceItemId, targetId)) {
      throw new BadRequestException('Cannot link an item to itself');
    }

    const sourceItem = await this.resolveItem(workspaceId, sourceItemId);
    const targetItem = await this.resolveItem(workspaceId, targetId);

    const linkedAt = new Date().toISOString();
    const type = dto.relationType || 'cites';

    const sourceRelation: StoredRelation = {
      targetItemId: targetItem.id,
      type: type as any,
      note: dto.note,
      linkedAt,
    };

    const targetRelation: StoredRelation = {
      targetItemId: sourceItem.id,
      type: type as any,
      note: dto.note,
      linkedAt,
    };

    await Promise.all([
      this.catalogRepo.putRelation(sourceItem.id, sourceRelation),
      this.catalogRepo.putRelation(targetItem.id, targetRelation),
    ]);

    return {
      success: true,
      link: {
        targetItemId: targetItem.id,
        type,
        note: dto.note,
        linkedAt,
      },
      message: `Linked "${sourceItem.title}" to "${targetItem.title}" (${type})`,
    };
  }

  /**
   * Unlink two items symmetrically.
   */
  async unlinkItems(
    workspaceId: string,
    sourceItemId: string,
    targetItemId: string,
    _relationType?: string,
  ): Promise<{ success: boolean; unlinked: boolean; message: string }> {
    const sourceItem = await this.resolveItem(workspaceId, sourceItemId);
    const targetItem = await this.resolveItem(workspaceId, targetItemId);

    await Promise.all([
      this.catalogRepo.removeRelation(sourceItem.id, targetItem.id),
      this.catalogRepo.removeRelation(targetItem.id, sourceItem.id),
    ]);

    return {
      success: true,
      unlinked: true,
      message: `Removed relation between "${sourceItem.title}" and "${targetItem.title}"`,
    };
  }

  async linkDirectedItems(
    workspaceId: string,
    sourceItemId: string,
    dto: LinkDirectedItemInput,
    _userId?: string,
  ): Promise<{ relation: StoredRelation; message: string }> {
    const sourceItem = await this.resolveItem(workspaceId, sourceItemId);
    const targetItem = await this.resolveItem(workspaceId, dto.targetItemId);

    if (isSelfRelation(sourceItem.id, targetItem.id)) {
      throw new BadRequestException('Cannot link an item to itself');
    }

    const relationType = (dto.relationType || 'cites') as RelationType;
    const existing = await this.catalogRepo.getRelations(sourceItem.id);
    const alreadyLinked = existing.some(
      (relation) =>
        (relation.targetItemId === targetItem.id ||
          relation.targetPaperId === targetItem.id) &&
        (relation.relationType === relationType ||
          relation.type === relationType),
    );

    if (alreadyLinked) {
      throw new BadRequestException(
        `Item is already linked with relation type "${relationType}"`,
      );
    }

    const linkedAt = new Date().toISOString();
    const relation: StoredRelation = {
      id: `rel_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      sourceItemId: sourceItem.id,
      targetItemId: targetItem.id,
      relationType,
      type: relationType,
      description: dto.description?.trim(),
      note: dto.description?.trim(),
      createdAt: linkedAt,
      linkedAt,
    };

    await this.catalogRepo.putRelation(sourceItem.id, relation);

    return {
      relation,
      message: `Linked "${sourceItem.title}" to "${targetItem.title}" (${relationType})`,
    };
  }

  async unlinkDirectedItems(
    workspaceId: string,
    sourceItemId: string,
    targetItemId: string,
    relationType?: string,
  ): Promise<{ unlinked: boolean; message: string }> {
    const sourceItem = await this.resolveItem(workspaceId, sourceItemId);
    const relations = await this.catalogRepo.getRelations(sourceItem.id);
    const exists = relations.some((relation) => {
      const matchesTarget =
        relation.targetItemId === targetItemId ||
        relation.targetPaperId === targetItemId;
      if (!matchesTarget) return false;
      return (
        !relationType ||
        relation.relationType === relationType ||
        relation.type === relationType
      );
    });

    if (!exists) {
      throw new NotFoundException('Relation not found between these items');
    }

    await this.catalogRepo.removeRelation(sourceItem.id, targetItemId);
    return { unlinked: true, message: 'Relation removed successfully' };
  }

  /**
   * Build the workspace Knowledge Graph using bulk relations fetch.
   */
  async getWorkspaceRelationGraph(workspaceId: string): Promise<RelationGraph> {
    const items = await this.catalogRepo.findItems({
      workspaceId,
      deletedAt: null,
    });

    if (items.length === 0) {
      return { nodes: [], edges: [], totalNodes: 0, totalEdges: 0 };
    }

    const itemIds = items.map((item) => item.id);
    const relationsMap = await this.catalogRepo.getBulkRelations(itemIds);

    const itemIdSet = new Set(itemIds);
    const seenEdges = new Set<string>();
    const edges: GraphEdge[] = [];
    const nodeDegreeMap = new Map<string, number>();

    for (const [sourceId, relations] of relationsMap.entries()) {
      for (const rel of relations) {
        const targetId = rel.targetPaperId || rel.targetItemId || '';
        if (!itemIdSet.has(targetId)) continue;

        const pairKey = toRelationPairKey(sourceId, targetId);
        if (seenEdges.has(pairKey)) continue;

        seenEdges.add(pairKey);
        edges.push({
          source: sourceId,
          target: targetId,
          relationType: rel.type || rel.relationType || 'related',
          note: rel.note || rel.description,
        });

        nodeDegreeMap.set(sourceId, (nodeDegreeMap.get(sourceId) ?? 0) + 1);
        nodeDegreeMap.set(targetId, (nodeDegreeMap.get(targetId) ?? 0) + 1);
      }
    }

    const nodes: GraphNode[] = items.map((item) => ({
      id: item.id,
      title: item.title,
      authors: item.authors || [],
      year: item.year ?? null,
      itemType: item.itemType ?? undefined,
      citationKey: item.citationKey ?? undefined,
      degree: nodeDegreeMap.get(item.id) ?? 0,
    }));

    return {
      nodes,
      edges,
      totalNodes: nodes.length,
      totalEdges: edges.length,
    };
  }

  async getWorkspaceGraph(workspaceId: string): Promise<RelationGraph> {
    const items = await this.catalogRepo.findItems({
      workspaceId,
      deletedAt: null,
    });

    if (items.length === 0) {
      return { nodes: [], edges: [], totalNodes: 0, totalEdges: 0 };
    }

    const itemMap = new Map(items.map((item) => [item.id, item]));
    const itemIds = items.map((item) => item.id);
    const relationsMap = await this.catalogRepo.getBulkRelations(itemIds);
    const degrees = new Map<string, number>();
    const edges: GraphEdge[] = [];

    for (const [sourceId, relations] of relationsMap.entries()) {
      for (const relation of relations) {
        const targetId = relation.targetItemId || relation.targetPaperId || '';
        if (!itemMap.has(targetId)) continue;

        const relationType =
          relation.relationType || relation.type || 'related';
        edges.push({
          id: relation.id || `edge_${sourceId}_${targetId}`,
          source: sourceId,
          target: targetId,
          relationType,
          description: relation.description || relation.note,
        });
        degrees.set(sourceId, (degrees.get(sourceId) || 0) + 1);
        degrees.set(targetId, (degrees.get(targetId) || 0) + 1);
      }
    }

    const nodes: GraphNode[] = items.map((item) => ({
      id: item.id,
      title: item.title,
      authors: item.authors || [],
      year: item.year || null,
      itemType: item.itemType || undefined,
      citationKey: item.citationKey || undefined,
      degree: degrees.get(item.id) || 0,
    }));

    return {
      nodes,
      edges,
      totalNodes: nodes.length,
      totalEdges: edges.length,
    };
  }

  private async resolveItem(workspaceId: string, itemId: string) {
    const item = await this.catalogRepo.findItemById(itemId);
    if (!item || item.workspaceId !== workspaceId || item.deletedAt) {
      throw new NotFoundException(
        `Library item not found in workspace: ${itemId}`,
      );
    }
    return item;
  }
}

export { RelationsService as RelationGraphService };
