import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { Prisma } from '@prisma/client';

export type CollectionWithCount = Prisma.CollectionGetPayload<{
  include: {
    _count?: {
      select: { catalogItems: true };
    };
  };
}>;

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

  async findWorkspaceCollections(workspaceId: string) {
    const ws = await this.resolveWorkspace(workspaceId);
    const targetWsId = ws?.id || workspaceId;
    return this.prisma.collection.findMany({
      where: { workspaceId: targetWsId },
      include: {
        _count: {
          select: { catalogItems: { where: { deletedAt: null } } },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findCollectionById(collectionId: string) {
    return this.prisma.collection.findUnique({
      where: { id: collectionId },
      include: {
        _count: {
          select: { catalogItems: { where: { deletedAt: null } } },
        },
      },
    });
  }

  async createCollection(
    data: Prisma.CollectionCreateInput | Prisma.CollectionUncheckedCreateInput,
  ) {
    return this.prisma.collection.create({
      data: data as Prisma.CollectionCreateInput,
    });
  }

  async updateCollection(
    collectionId: string,
    data: Prisma.CollectionUpdateInput | Prisma.CollectionUncheckedUpdateInput,
  ) {
    return this.prisma.collection.update({
      where: { id: collectionId },
      data: data,
    });
  }

  async reparentChildren(oldParentId: string, newParentId: string | null) {
    return this.prisma.collection.updateMany({
      where: { parentId: oldParentId },
      data: { parentId: newParentId },
    });
  }

  async movePapers(
    workspaceId: string,
    targetCollectionId: string | null,
    paperIds: string[],
  ) {
    const ws = await this.resolveWorkspace(workspaceId);
    const targetWsId = ws?.id || workspaceId;
    return this.prisma.catalogItem.updateMany({
      where: {
        workspaceId: targetWsId,
        id: { in: paperIds },
      },
      data: {
        collectionId: targetCollectionId,
      },
    });
  }

  async deleteCollection(collectionId: string) {
    return this.prisma.collection.delete({
      where: { id: collectionId },
    });
  }

  async findPapersInCollection(
    workspaceId: string,
    collectionId: string,
    includeAttachments?: false,
  ): Promise<Prisma.CatalogItemGetPayload<Record<string, never>>[]>;

  async findPapersInCollection(
    workspaceId: string,
    collectionId: string,
    includeAttachments: true,
  ): Promise<
    Prisma.CatalogItemGetPayload<{ include: { attachments: true } }>[]
  >;

  async findPapersInCollection(
    workspaceId: string,
    collectionId: string,
    includeAttachments = false,
  ) {
    if (includeAttachments) {
      return this.prisma.catalogItem.findMany({
        where: { workspaceId, collectionId, deletedAt: null },
        include: { attachments: true },
        orderBy: [{ createdAt: 'desc' }],
      });
    }
    return this.prisma.catalogItem.findMany({
      where: { workspaceId, collectionId, deletedAt: null },
      orderBy: [{ createdAt: 'desc' }],
    });
  }
}
