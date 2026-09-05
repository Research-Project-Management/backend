import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  UpsertSyncCollectionCommand,
  DeleteSyncEntityCommand,
  UpsertSyncEntityResult,
} from '../sync/ports/sync.port';
import type { TransactionHelpers } from '../outbox/transaction.service';
import { CollectionsRepository } from './collections.repository';
import { CreateCollectionDto } from './dto/create-collection.dto';
import { UpdateCollectionDto } from './dto/update-collection.dto';
import { AssignItemsToCollectionDto } from './dto/assign-items.dto';
import {
  CollectionDeleteStrategy,
  CollectionTreeNode,
} from './types/collection.types';
import { PrismaService } from '../../../core/database/prisma.service';
import { resolveTenantWorkspaceId } from '../../../core/utils/tenant.util';

@Injectable()
export class CollectionsService {
  private readonly logger = new Logger(CollectionsService.name);

  constructor(
    private readonly collectionsRepo: CollectionsRepository,
    private readonly prisma: PrismaService,
  ) {}

  private resolveWorkspaceId(workspaceId: string): Promise<string> {
    return resolveTenantWorkspaceId(this.prisma, workspaceId);
  }

  async getCollections(workspaceId: string) {
    const wsId = await this.resolveWorkspaceId(workspaceId);
    const rawCollections = await this.collectionsRepo.findAll(wsId);
    const collections = rawCollections.map((c: any) => ({
      ...c,
      itemCount: c.itemCount ?? c._count?.collectionItems ?? 0,
      itemsCount: c.itemsCount ?? c._count?.collectionItems ?? 0,
      paperCount: c.paperCount ?? c._count?.collectionItems ?? 0,
    }));
    return {
      collections,
      total: collections.length,
    };
  }

  async getCollectionTree(
    workspaceId: string,
  ): Promise<{ tree: CollectionTreeNode[] }> {
    const wsId = await this.resolveWorkspaceId(workspaceId);
    const collections = await this.collectionsRepo.findAll(wsId);

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
    const wsId = await this.resolveWorkspaceId(workspaceId);
    const raw = await this.collectionsRepo.findById(wsId, collectionId);
    if (!raw) {
      throw new NotFoundException(`Collection not found: ${collectionId}`);
    }
    const collection = {
      ...raw,
      itemCount:
        (raw as any).itemCount ?? (raw as any)._count?.collectionItems ?? 0,
      itemsCount:
        (raw as any).itemsCount ?? (raw as any)._count?.collectionItems ?? 0,
      paperCount:
        (raw as any).paperCount ?? (raw as any)._count?.collectionItems ?? 0,
    };
    return { collection };
  }

  async createCollection(
    workspaceId: string,
    userId: string,
    dto: CreateCollectionDto,
  ) {
    const wsId = await this.resolveWorkspaceId(workspaceId);

    // Normalize parentId from parentId or parent, treating 'root' or empty string as null
    let rawParentId =
      dto.parentId !== undefined ? dto.parentId : (dto as any).parent;
    if (rawParentId === 'root' || rawParentId === '') rawParentId = null;

    if (rawParentId) {
      const parent = await this.collectionsRepo.findById(wsId, rawParentId);
      if (!parent) {
        throw new BadRequestException(
          `Parent collection not found: ${rawParentId}`,
        );
      }
    }

    // Ensure valid authorId for foreign key constraint
    let authorId = userId;
    if (!authorId || authorId === 'system') {
      const member = await this.prisma.workspaceMember.findFirst({
        where: { workspaceId: wsId },
        select: { userId: true },
      });
      authorId = member?.userId || authorId;
    }

    const collection = await this.collectionsRepo.create(wsId, authorId, {
      name: dto.name,
      description: dto.description,
      color: dto.color,
      icon: dto.icon,
      parentId: rawParentId,
    });

    return { collection };
  }

  async updateCollection(
    workspaceId: string,
    collectionId: string,
    dto: UpdateCollectionDto,
  ) {
    const wsId = await this.resolveWorkspaceId(workspaceId);
    const existing = await this.collectionsRepo.findById(wsId, collectionId);
    if (!existing) {
      throw new NotFoundException(`Collection not found: ${collectionId}`);
    }

    let rawParentId =
      dto.parentId !== undefined ? dto.parentId : (dto as any).parent;
    if (rawParentId === 'root' || rawParentId === '') rawParentId = null;

    if (rawParentId) {
      if (rawParentId === collectionId) {
        throw new BadRequestException('A collection cannot be its own parent');
      }
      const parent = await this.collectionsRepo.findById(wsId, rawParentId);
      if (!parent) {
        throw new BadRequestException(
          `Parent collection not found: ${rawParentId}`,
        );
      }
    }

    const collection = await this.collectionsRepo.update(wsId, collectionId, {
      ...dto,
      parentId: rawParentId,
    });
    return { collection };
  }

  async deleteCollection(
    workspaceId: string,
    collectionId: string,
    strategy: CollectionDeleteStrategy = 'orphan',
  ) {
    const wsId = await this.resolveWorkspaceId(workspaceId);
    const existing = await this.collectionsRepo.findById(wsId, collectionId);
    if (!existing) {
      throw new NotFoundException(`Collection not found: ${collectionId}`);
    }

    await this.collectionsRepo.delete(wsId, collectionId, strategy);
    return { success: true };
  }

  async moveItems(
    workspaceId: string,
    collectionId: string,
    itemIds: string[],
  ) {
    const wsId = await this.resolveWorkspaceId(workspaceId);
    if (collectionId !== 'unfiled') {
      const collection = await this.collectionsRepo.findById(
        wsId,
        collectionId,
      );
      if (!collection) {
        throw new NotFoundException(`Collection not found: ${collectionId}`);
      }
    }

    const targetId = collectionId === 'unfiled' ? null : collectionId;
    await this.collectionsRepo.moveItems(wsId, targetId, itemIds);

    return {
      message: 'Items moved successfully',
      count: itemIds.length,
      targetCollectionId: targetId,
    };
  }

  async reorderCollections(
    workspaceId: string,
    collections: Array<{
      id: string;
      parentId?: string | null;
      orderIndex?: number;
    }>,
  ) {
    const wsId = await this.resolveWorkspaceId(workspaceId);
    await this.collectionsRepo.reorder(wsId, collections);
    const updated = await this.collectionsRepo.findAll(wsId);
    return { collections: updated };
  }

  async assignItemsToCollection(
    workspaceId: string,
    collectionId: string,
    dto: AssignItemsToCollectionDto,
  ) {
    const wsId = await this.resolveWorkspaceId(workspaceId);
    const collection = await this.collectionsRepo.findById(wsId, collectionId);
    if (!collection) {
      throw new NotFoundException(`Collection not found: ${collectionId}`);
    }

    const ids = dto.itemIds || [];
    for (const itemId of ids) {
      await this.collectionsRepo.addItem(wsId, collectionId, itemId);
    }

    return { success: true, count: ids.length };
  }

  async detachItemFromCollection(
    workspaceId: string,
    collectionId: string,
    itemId: string,
  ) {
    const wsId = await this.resolveWorkspaceId(workspaceId);
    const collection = await this.collectionsRepo.findById(wsId, collectionId);
    if (!collection) {
      throw new NotFoundException(`Collection not found: ${collectionId}`);
    }

    await this.collectionsRepo.removeItem(wsId, collectionId, itemId);
    return { success: true };
  }

  /**
   * Sync protocol adapter: transactional upsert for a Collection from an external sync batch.
   */
  async upsertFromSync(
    command: UpsertSyncCollectionCommand,
    tx: Prisma.TransactionClient,
    helpers: TransactionHelpers,
  ): Promise<UpsertSyncEntityResult> {
    if (command.existingId) {
      const existing = await tx.collection.findUnique({
        where: { id: command.existingId },
      });

      if (!existing) {
        throw new NotFoundException(
          `Collection ${command.existingId} not found in workspace ${command.workspaceId}`,
        );
      }

      if (existing.workspaceId !== command.workspaceId) {
        throw new ForbiddenException(
          `Collection ${command.existingId} does not belong to workspace ${command.workspaceId}`,
        );
      }

      const updated = await tx.collection.update({
        where: { id: command.existingId },
        data: {
          name: command.name,
          description: command.description,
          parentId: command.parentCollectionId || null,
          version: { increment: 1 },
        },
      });

      await helpers.appendChange(command.workspaceId, {
        entityType: 'Collection',
        entityId: updated.id,
        action: 'update',
        version: updated.version,
        data: { name: command.name },
      });

      return { id: updated.id, isNew: false, version: updated.version };
    } else {
      const created = await tx.collection.create({
        data: {
          workspaceId: command.workspaceId,
          name: command.name,
          description: command.description,
          parentId: command.parentCollectionId || null,
          createdById: command.userId,
          version: 1,
        },
      });

      await helpers.appendChange(command.workspaceId, {
        entityType: 'Collection',
        entityId: created.id,
        action: 'create',
        version: created.version,
        data: { name: command.name },
      });

      await helpers.publishOutbox(
        command.workspaceId,
        created.id,
        'library.collection.created',
        { collectionId: created.id },
      );

      return { id: created.id, isNew: true, version: created.version };
    }
  }

  /**
   * Sync protocol adapter: transactional soft-deletion for a Collection from an external sync batch.
   */
  async deleteFromSync(
    command: DeleteSyncEntityCommand,
    tx: Prisma.TransactionClient,
    helpers: TransactionHelpers,
  ): Promise<void> {
    const { workspaceId, entityId } = command;
    const existing = await tx.collection.findUnique({
      where: { id: entityId },
    });
    if (!existing) return;

    if (existing.workspaceId !== workspaceId) {
      throw new ForbiddenException(
        `Collection ${entityId} does not belong to workspace ${workspaceId}`,
      );
    }

    await tx.collection.update({
      where: { id: entityId },
      data: { deletedAt: new Date() },
    });
    await helpers.appendChange(workspaceId, {
      entityType: 'Collection',
      entityId,
      action: 'delete',
      version: existing.version + 1,
    });
    await helpers.recordTombstone(workspaceId, {
      entityType: 'Collection',
      entityId,
    });
  }

  /**
   * Domain merge helper: reassigns all collection memberships from duplicate items to a target item.
   */
  async transferItemMemberships(
    sourceItemIds: string[],
    targetItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    if (sourceItemIds.length === 0) return;

    const primaryItems = await tx.collectionItem.findMany({
      where: { catalogItemId: targetItemId },
      select: { collectionId: true },
    });
    const primaryCollectionIds = new Set(primaryItems.map((ci) => ci.collectionId));

    const dupItems = await tx.collectionItem.findMany({
      where: { catalogItemId: { in: sourceItemIds } },
      select: { collectionId: true },
    });

    for (const dup of dupItems) {
      if (!primaryCollectionIds.has(dup.collectionId)) {
        await tx.collectionItem.upsert({
          where: {
            collectionId_catalogItemId: {
              collectionId: dup.collectionId,
              catalogItemId: targetItemId,
            },
          },
          create: {
            catalogItemId: targetItemId,
            collectionId: dup.collectionId,
          },
          update: {},
        });
        primaryCollectionIds.add(dup.collectionId);
      }
    }

    await tx.collectionItem.deleteMany({
      where: { catalogItemId: { in: sourceItemIds } },
    });
  }
}
