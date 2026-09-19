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
    userId: string,
    options?: { includeInactive?: boolean; projectId?: string },
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    const where: Prisma.TagWhereInput =
      options?.projectId && options.projectId !== 'user'
        ? {
            projectId: options.projectId,
            ...(options?.includeInactive
              ? {}
              : {
                  itemTags: {
                    some: {
                      item: { deletedAt: null },
                    },
                  },
                }),
          }
        : {
            userId,
            ...(options?.includeInactive
              ? {}
              : {
                  itemTags: {
                    some: {
                      item: { deletedAt: null },
                    },
                  },
                }),
          };

    return client.tag.findMany({
      where,
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
    userId: string,
    name: string,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    return client.tag.findFirst({
      where: {
        userId,
        name,
      },
    });
  }

  async create(
    userId: string,
    name: string,
    color = '#3b82f6',
    type = 'manual',
    projectIdOrTx?: string | null | Prisma.TransactionClient,
    tx?: Prisma.TransactionClient,
  ) {
    const projectId =
      typeof projectIdOrTx === 'string' ? projectIdOrTx : undefined;
    const client = this.getClient(
      typeof projectIdOrTx === 'object' && projectIdOrTx !== null
        ? projectIdOrTx
        : tx,
    );
    const effectiveProjectId =
      typeof projectIdOrTx === 'string' && projectIdOrTx !== 'user'
        ? projectIdOrTx
        : undefined;

    return client.tag.upsert({
      where: { userId_name: { userId, name } },
      create: {
        userId,
        name,
        color,
        type,
        ...(effectiveProjectId ? { projectId: effectiveProjectId } : {}),
      },
      update: { color },
    });
  }

  async delete(
    userId: string,
    id: string,
    tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    const client = this.getClient(tx);
    const result = await client.tag.deleteMany({
      where: { id, userId },
    });
    return result.count > 0;
  }

  async deleteAutomatic(
    userId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<string[]> {
    const client = this.getClient(tx);
    const automaticTags = await client.tag.findMany({
      where: {
        userId,
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
