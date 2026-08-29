import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { CollectionsRepository } from './collections.repository';
import { CreateCollectionDto } from './dto/create-collection.dto';
import { UpdateCollectionDto } from './dto/update-collection.dto';
import { AssignItemsToCollectionDto } from './dto/assign-items.dto';
import { CollectionDeleteStrategy, CollectionTreeNode } from './types/collection.types';
import { PrismaService } from '../../../core/database/prisma.service';

@Injectable()
export class CollectionsService {
  private readonly logger = new Logger(CollectionsService.name);

  constructor(
    private readonly collectionsRepo: CollectionsRepository,
    private readonly prisma: PrismaService,
  ) {}

  async getCollections(workspaceId: string) {
    const collections = await this.collectionsRepo.findAll(workspaceId);
    return {
      collections,
      total: collections.length,
    };
  }

  async getCollectionTree(workspaceId: string): Promise<{ tree: CollectionTreeNode[] }> {
    const collections = await this.collectionsRepo.findAll(workspaceId);

    const map = new Map<string, CollectionTreeNode>();
    for (const c of collections) {
      map.set(c.id, {
        id: c.id,
        name: c.name,
        description: c.description,
        color: c.color,
        icon: c.icon,
        parentId: c.parentId,
        itemCount: (c as any)._count?.collectionItems || 0,
        children: [],
      });
    }

    const roots: CollectionTreeNode[] = [];
    for (const node of map.values()) {
      if (node.parentId && map.has(node.parentId)) {
        map.get(node.parentId)!.children.push(node);
      } else {
        roots.push(node);
      }
    }

    return { tree: roots };
  }

  async getCollectionById(workspaceId: string, collectionId: string) {
    const collection = await this.collectionsRepo.findById(workspaceId, collectionId);
    if (!collection) {
      throw new NotFoundException(`Collection not found: ${collectionId}`);
    }
    return { collection };
  }

  async createCollection(
    workspaceId: string,
    userId: string,
    dto: CreateCollectionDto,
  ) {
    if (dto.parentId) {
      const parent = await this.collectionsRepo.findById(workspaceId, dto.parentId);
      if (!parent) {
        throw new BadRequestException(`Parent collection not found: ${dto.parentId}`);
      }
    }

    const collection = await this.collectionsRepo.create(workspaceId, userId, {
      name: dto.name,
      description: dto.description,
      color: dto.color,
      icon: dto.icon,
      parentId: dto.parentId,
    });

    return { collection };
  }

  async updateCollection(
    workspaceId: string,
    collectionId: string,
    dto: UpdateCollectionDto,
  ) {
    const existing = await this.collectionsRepo.findById(workspaceId, collectionId);
    if (!existing) {
      throw new NotFoundException(`Collection not found: ${collectionId}`);
    }

    if (dto.parentId) {
      if (dto.parentId === collectionId) {
        throw new BadRequestException('A collection cannot be its own parent');
      }
      const parent = await this.collectionsRepo.findById(workspaceId, dto.parentId);
      if (!parent) {
        throw new BadRequestException(`Parent collection not found: ${dto.parentId}`);
      }
    }

    const collection = await this.collectionsRepo.update(workspaceId, collectionId, dto);
    return { collection };
  }

  async deleteCollection(
    workspaceId: string,
    collectionId: string,
    strategy: CollectionDeleteStrategy = 'orphan',
  ) {
    const existing = await this.collectionsRepo.findById(workspaceId, collectionId);
    if (!existing) {
      throw new NotFoundException(`Collection not found: ${collectionId}`);
    }

    await this.collectionsRepo.delete(workspaceId, collectionId, strategy);
    return { success: true };
  }

  async moveItems(
    workspaceId: string,
    collectionId: string,
    itemIds: string[],
  ) {
    if (collectionId !== 'unfiled') {
      const collection = await this.collectionsRepo.findById(workspaceId, collectionId);
      if (!collection) {
        throw new NotFoundException(`Collection not found: ${collectionId}`);
      }
    }

    const targetId = collectionId === 'unfiled' ? null : collectionId;
    await this.collectionsRepo.moveItems(workspaceId, targetId, itemIds);

    return {
      message: 'Items moved successfully',
      count: itemIds.length,
      targetCollectionId: targetId,
    };
  }

  async reorderCollections(
    workspaceId: string,
    collections: Array<{ id: string; parentId?: string | null; orderIndex?: number }>,
  ) {
    await this.collectionsRepo.reorder(workspaceId, collections);
    const updated = await this.collectionsRepo.findAll(workspaceId);
    return { collections: updated };
  }

  async assignItemsToCollection(
    workspaceId: string,
    collectionId: string,
    dto: AssignItemsToCollectionDto,
  ) {
    const collection = await this.collectionsRepo.findById(workspaceId, collectionId);
    if (!collection) {
      throw new NotFoundException(`Collection not found: ${collectionId}`);
    }

    const ids = dto.itemIds || dto.paperIds || [];
    for (const itemId of ids) {
      await this.collectionsRepo.addItem(workspaceId, collectionId, itemId);
    }

    return { success: true, count: ids.length };
  }

  async detachItemFromCollection(
    workspaceId: string,
    collectionId: string,
    itemId: string,
  ) {
    const collection = await this.collectionsRepo.findById(workspaceId, collectionId);
    if (!collection) {
      throw new NotFoundException(`Collection not found: ${collectionId}`);
    }

    await this.collectionsRepo.removeItem(workspaceId, collectionId, itemId);
    return { success: true };
  }
}
