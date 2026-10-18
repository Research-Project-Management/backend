import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { QueryRepository } from '@/modules/library/catalog/repositories/query.repository';
import { CommandRepository } from '@/modules/library/catalog/repositories/command.repository';
import { ItemDetail } from '@/modules/library/catalog/types/items.types';

@Injectable()
export class ItemRelationsService {
  private readonly logger = new Logger(ItemRelationsService.name);

  constructor(
    private readonly query: QueryRepository,
    private readonly command: CommandRepository,
  ) {}

  async getRelatedItems(userId: string, itemId: string, projectId?: string) {
    const item = await this.query.findById(userId, itemId, projectId);
    if (!item) {
      throw new NotFoundException(`Item ${itemId} not found`);
    }

    const relations = await this.query.getRelations(itemId);
    return {
      relatedItems: relations,
      total: relations.length,
    };
  }

  async linkItems(
    userId: string,
    sourceItemId: string,
    data: {
      targetItemId?: string;
      targetItemIds?: string[];
      relationType?: string;
      note?: string;
    },
    projectId?: string,
  ) {
    const sourceItem = await this.query.findById(
      userId,
      sourceItemId,
      projectId,
    );
    if (!sourceItem) {
      throw new NotFoundException(`Source item ${sourceItemId} not found`);
    }

    const rawIds = [
      ...(Array.isArray(data.targetItemIds) ? data.targetItemIds : []),
      ...(data.targetItemId ? [data.targetItemId] : []),
    ];
    const targetIds = Array.from(
      new Set(rawIds.filter((id) => id && id !== sourceItemId)),
    );

    if (targetIds.length === 0) {
      throw new BadRequestException(
        'At least one valid target item ID (different from source) must be provided',
      );
    }

    const type = data.relationType ?? 'related';
    const now = new Date().toISOString();
    const linkedRelations = [];

    // Batch fetch target items to eliminate N+1 queries
    let targetItemMap = new Map<string, ItemDetail>();
    if (this.query.findByIds && targetIds.length > 0) {
      const targetItems = await this.query.findByIds(
        userId,
        targetIds,
        projectId,
      );
      if (targetItems && targetItems.length > 0) {
        targetItemMap = new Map(targetItems.map((item) => [item.id, item]));
      }
    }

    for (const targetId of targetIds) {
      const targetItem =
        targetItemMap.get(targetId) ||
        (await this.query.findById(userId, targetId, projectId));
      if (!targetItem) continue;

      const relation = {
        id: randomUUID(),
        targetItemId: targetId,
        relationType: type,
        note: data.note,
        linkedAt: now,
      };

      await this.command.putRelation(sourceItemId, relation);
      linkedRelations.push({
        ...relation,
        targetTitle: targetItem.title,
      });
    }

    return {
      success: true,
      link: linkedRelations[0] || null,
      links: linkedRelations,
      totalLinked: linkedRelations.length,
      message:
        linkedRelations.length === 1
          ? `Linked "${sourceItem.title}" to "${linkedRelations[0].targetTitle}"`
          : `Linked ${linkedRelations.length} item(s) to "${sourceItem.title}"`,
    };
  }

  async unlinkItems(
    userId: string,
    sourceItemId: string,
    targetItemId: string,
    projectId?: string,
  ) {
    const sourceItem = await this.query.findById(
      userId,
      sourceItemId,
      projectId,
    );
    if (!sourceItem) {
      throw new NotFoundException(`Source item ${sourceItemId} not found`);
    }

    await this.command.removeRelation(sourceItemId, targetItemId);

    return {
      success: true,
      unlinked: true,
      message: `Removed relation between "${sourceItem.title}" and "${targetItemId}"`,
    };
  }
}
