import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../core/database/prisma.service';
import { Prisma } from '@prisma/client';

@Injectable()
export class TagsRepository {
  constructor(private readonly prisma: PrismaService) {}

  private getClient(tx?: Prisma.TransactionClient) {
    return tx ?? this.prisma;
  }

  async findMany(workspaceId: string, tx?: Prisma.TransactionClient) {
    const client = this.getClient(tx);
    return client.catalogTag.findMany({
      where: { workspaceId },
      orderBy: { name: 'asc' },
      include: {
        _count: {
          select: { itemTags: true },
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
    return client.catalogTag.findUnique({
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
    return client.catalogTag.upsert({
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
    const result = await client.catalogTag.deleteMany({
      where: { id, workspaceId },
    });
    return result.count > 0;
  }

  async assignToItem(
    tagId: string,
    catalogItemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = this.getClient(tx);
    await client.catalogItemTag.upsert({
      where: {
        tagId_catalogItemId: {
          tagId,
          catalogItemId,
        },
      },
      create: {
        tagId,
        catalogItemId,
      },
      update: {},
    });
  }

  async removeFromItem(
    tagId: string,
    catalogItemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = this.getClient(tx);
    await client.catalogItemTag.deleteMany({
      where: {
        tagId,
        catalogItemId,
      },
    });
  }
}
