import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../core/database/prisma.service';
import { Prisma } from '@prisma/client';

@Injectable()
export class TagsRepository {
  constructor(private readonly prisma: PrismaService) {}

  private getClient(tx?: Prisma.TransactionClient) {
    return tx ?? this.prisma;
  }

  async findMany(
    workspaceId: string,
    options?: { includeInactive?: boolean },
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    return client.tag.findMany({
      where: {
        workspaceId,
        ...(options?.includeInactive
          ? {}
          : {
              itemTags: {
                some: {
                  item: { deletedAt: null },
                },
              },
            }),
      },
      orderBy: { name: 'asc' },
      include: {
        _count: {
          select: {
            itemTags: {
              where: {
                item: { deletedAt: null },
              },
            },
          },
        },
      },
    });
  }

  async findByName(
    workspaceId: string,
    name: string,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    return client.tag.findUnique({
      where: {
        workspaceId_name: {
          workspaceId,
          name,
        },
      },
    });
  }

  async create(
    workspaceId: string,
    name: string,
    color = '#3b82f6',
    type = 'manual',
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    return client.tag.upsert({
      where: {
        workspaceId_name: {
          workspaceId,
          name,
        },
      },
      create: {
        workspaceId,
        name,
        color,
        type,
      },
      update: {
        color,
      },
    });
  }

  async delete(
    workspaceId: string,
    id: string,
    tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    const client = this.getClient(tx);
    const result = await client.tag.deleteMany({
      where: { id, workspaceId },
    });
    return result.count > 0;
  }

  async deleteAutomatic(
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<string[]> {
    const client = this.getClient(tx);
    const automaticTags = await client.tag.findMany({
      where: {
        workspaceId,
        type: { in: ['automatic', 'academic'] },
      },
      select: { id: true },
    });
    if (automaticTags.length === 0) return [];
    const tagIds = automaticTags.map((t) => t.id);

    await client.itemTag.deleteMany({
      where: { tagId: { in: tagIds } },
    });

    await client.tag.deleteMany({
      where: { id: { in: tagIds } },
    });

    return tagIds;
  }

  async assignToItem(
    tagId: string,
    itemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = this.getClient(tx);
    await client.itemTag.upsert({
      where: {
        tagId_itemId: {
          tagId,
          itemId,
        },
      },
      create: {
        tagId,
        itemId,
      },
      update: {},
    });
  }

  async removeFromItem(
    tagId: string,
    itemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = this.getClient(tx);
    await client.itemTag.deleteMany({
      where: {
        tagId,
        itemId,
      },
    });
  }
}
