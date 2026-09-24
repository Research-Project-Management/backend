import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import {
  ITEM_REPOSITORY_PORT,
  IItemRepositoryPort,
} from '../../domain/ports/item-repository.port';
import { randomUUID } from 'crypto';

export interface LinkItemsCommand {
  userId: string;
  sourceItemId: string;
  data: {
    targetItemId?: string;
    targetItemIds?: string[];
    relationType?: string;
    note?: string;
  };
  projectId?: string;
}

export interface UnlinkItemsCommand {
  userId: string;
  sourceItemId: string;
  targetItemId: string;
  projectId?: string;
}

@Injectable()
export class ManageRelationsUseCase {
  private readonly logger = new Logger(ManageRelationsUseCase.name);

  constructor(
    @Inject(ITEM_REPOSITORY_PORT)
    private readonly itemRepo: IItemRepositoryPort,
  ) {}

  async getRelatedItems(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<{ relatedItems: any[]; total: number }> {
    const item = await this.itemRepo.findById(userId, itemId, projectId);
    if (!item) {
      throw new NotFoundException(`Item ${itemId} not found`);
    }

    const relations = await this.itemRepo.getRelations(itemId);
    return {
      relatedItems: relations,
      total: relations.length,
    };
  }

  async linkItems(command: LinkItemsCommand) {
    const { userId, sourceItemId, data, projectId } = command;
    const sourceItem = await this.itemRepo.findById(
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

    for (const targetId of targetIds) {
      const targetItem = await this.itemRepo.findById(
        userId,
        targetId,
        projectId,
      );
      if (!targetItem) continue;

      const relation = {
        id: randomUUID(),
        targetItemId: targetId,
        relationType: type,
        note: data.note,
        description: data.note || (data as any).description || '',
        linkedAt: now,
      };

      await this.itemRepo.putRelation(sourceItemId, relation);
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

  async unlinkItems(command: UnlinkItemsCommand) {
    const { userId, sourceItemId, targetItemId, projectId } = command;
    const sourceItem = await this.itemRepo.findById(
      userId,
      sourceItemId,
      projectId,
    );
    if (!sourceItem) {
      throw new NotFoundException(`Source item ${sourceItemId} not found`);
    }

    await this.itemRepo.removeRelation(sourceItemId, targetItemId);

    return {
      success: true,
      unlinked: true,
      message: `Removed relation between "${sourceItem.title}" and "${targetItemId}"`,
    };
  }
}
