import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { Prisma } from '@prisma/client';
import {
  CollectionRecord,
  COLLECTION_INCLUDE_COUNT,
} from './types/collections.types';

@Injectable()
export class CollectionsRepository {
  constructor(public readonly prisma: PrismaService) {}

  async resolveWorkspace(workspaceIdOrSlug: string) {
    return this.prisma.workspace.findFirst({
      where: {
        OR: [{ id: workspaceIdOrSlug }, { url: workspaceIdOrSlug }],
      },
      select: { id: true },
    });
  }

  async resolveWorkspaceId(workspaceIdOrSlug: string): Promise<string> {
    const ws = await this.resolveWorkspace(workspaceIdOrSlug);
    return ws?.id || workspaceIdOrSlug;
  }

  async findWorkspaceCollections(
    workspaceId: string,
  ): Promise<CollectionRecord[]> {
    const targetWsId = await this.resolveWorkspaceId(workspaceId);
    return this.prisma.collection.findMany({
      where: { workspaceId: targetWsId },
      include: COLLECTION_INCLUDE_COUNT,
      orderBy: [{ createdAt: 'asc' }],
    });
  }

  async findCollectionById(
    collectionId: string,
  ): Promise<CollectionRecord | null> {
    return this.prisma.collection.findUnique({
      where: { id: collectionId },
      include: COLLECTION_INCLUDE_COUNT,
    });
  }

  async createCollection(
    data: Prisma.CollectionCreateInput | Prisma.CollectionUncheckedCreateInput,
  ): Promise<CollectionRecord> {
    return this.prisma.collection.create({
      data: data as Prisma.CollectionCreateInput,
      include: COLLECTION_INCLUDE_COUNT,
    });
  }

  async updateCollection(
    collectionId: string,
    data: Prisma.CollectionUpdateInput | Prisma.CollectionUncheckedUpdateInput,
  ): Promise<CollectionRecord> {
    return this.prisma.collection.update({
      where: { id: collectionId },
      data,
      include: COLLECTION_INCLUDE_COUNT,
    });
  }

  async reparentChildren(oldParentId: string, newParentId: string | null) {
    return this.prisma.collection.updateMany({
      where: { parentId: oldParentId },
      data: { parentId: newParentId },
    });
  }

  async moveItems(
    workspaceId: string,
    targetCollectionId: string | null,
    itemIds: string[],
  ) {
    const targetWsId = await this.resolveWorkspaceId(workspaceId);
    return this.prisma.catalogItem.updateMany({
      where: {
        workspaceId: targetWsId,
        id: { in: itemIds },
      },
      data: {
        collectionId: targetCollectionId,
      },
    });
  }

  async detachItemFromCollection(
    workspaceId: string,
    collectionId: string,
    itemId: string,
  ) {
    const targetWsId = await this.resolveWorkspaceId(workspaceId);
    return this.prisma.catalogItem.updateMany({
      where: {
        workspaceId: targetWsId,
        collectionId,
        id: itemId,
      },
      data: {
        collectionId: null,
      },
    });
  }

  async deleteCollection(collectionId: string) {
    return this.prisma.collection.delete({
      where: { id: collectionId },
    });
  }

  async findItemsInCollection(
    workspaceId: string,
    collectionId: string,
    includeAttachments?: boolean,
  ) {
    const targetWsId = await this.resolveWorkspaceId(workspaceId);
    return this.prisma.catalogItem.findMany({
      where: {
        workspaceId: targetWsId,
        collectionId,
        deletedAt: null,
      },
      include: includeAttachments ? { attachments: true } : undefined,
      orderBy: [{ createdAt: 'desc' }],
    });
  }

  // Compatibility aliases
  async movePapers(
    workspaceId: string,
    targetCollectionId: string | null,
    itemIds: string[],
  ) {
    return this.moveItems(workspaceId, targetCollectionId, itemIds);
  }

  async detachPaperFromCollection(
    workspaceId: string,
    collectionId: string,
    itemId: string,
  ) {
    return this.detachItemFromCollection(workspaceId, collectionId, itemId);
  }

  async findPapersInCollection(
    workspaceId: string,
    collectionId: string,
    includeAttachments?: boolean,
  ) {
    return this.findItemsInCollection(
      workspaceId,
      collectionId,
      includeAttachments,
    );
  }
}
