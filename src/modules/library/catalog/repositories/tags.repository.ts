import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core';
import { Prisma, TagType } from '@prisma/client';

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
            projectId: null,
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
    projectId?: string,
  ) {
    const client = this.getClient(tx);
    const scopeWhere =
      projectId && projectId !== 'user'
        ? { projectId }
        : { userId, projectId: null };
    return client.tag.findFirst({
      where: {
        name: { equals: name, mode: 'insensitive' },
        ...scopeWhere,
      },
    });
  }

  async create(
    userId: string,
    name: string,
    color = '#3b82f6',
    type: TagType = TagType.manual,
    projectIdOrTx?: string | null | Prisma.TransactionClient,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(
      typeof projectIdOrTx === 'object' && projectIdOrTx !== null
        ? projectIdOrTx
        : tx,
    );
    const effectiveProjectId =
      typeof projectIdOrTx === 'string' && projectIdOrTx !== 'user'
        ? projectIdOrTx
        : undefined;

    const resolvedType = type || TagType.manual;

    if (effectiveProjectId) {
      const existingProjectTag = await client.tag.findFirst({
        where: {
          projectId: effectiveProjectId,
          name: { equals: name, mode: 'insensitive' },
        },
      });
      if (existingProjectTag) {
        if (color && existingProjectTag.color !== color) {
          return client.tag.update({
            where: { id: existingProjectTag.id },
            data: { color },
          });
        }
        return existingProjectTag;
      }

      return client.tag.create({
        data: {
          userId,
          createdById: userId,
          name,
          color,
          type: resolvedType,
          projectId: effectiveProjectId,
        },
      });
    }

    // Personal scope
    const existingPersonalTag = await client.tag.findFirst({
      where: {
        userId,
        projectId: null,
        name: { equals: name, mode: 'insensitive' },
      },
    });

    if (existingPersonalTag) {
      if (color && existingPersonalTag.color !== color) {
        return client.tag.update({
          where: { id: existingPersonalTag.id },
          data: { color },
        });
      }
      return existingPersonalTag;
    }

    return client.tag.create({
      data: {
        userId,
        createdById: userId,
        name,
        color,
        type: resolvedType,
        projectId: null,
      },
    });
  }

  async update(
    userId: string,
    id: string,
    data: { name?: string; color?: string; type?: TagType },
    tx?: Prisma.TransactionClient,
    projectId?: string,
  ) {
    const client = this.getClient(tx);
    const isProject = Boolean(projectId && projectId !== 'user');
    const scopeWhere: Prisma.TagWhereInput = isProject
      ? { id, projectId }
      : { id, userId, projectId: null };

    const tag = await client.tag.findFirst({
      where: scopeWhere,
    });
    if (!tag) return null;

    // If renaming to a name that already exists on another tag in the same scope,
    // non-destructively merge itemTags into the existing target tag and remove the duplicate tag.
    if (
      data.name !== undefined &&
      data.name.trim().toLowerCase() !== tag.name.trim().toLowerCase()
    ) {
      const targetWhere: Prisma.TagWhereInput = isProject
        ? {
            projectId,
            id: { not: tag.id },
            name: { equals: data.name, mode: 'insensitive' },
          }
        : {
            userId,
            projectId: null,
            id: { not: tag.id },
            name: { equals: data.name, mode: 'insensitive' },
          };
      const conflictingTag = await client.tag.findFirst({
        where: targetWhere,
      });

      if (conflictingTag) {
        if (
          typeof client.itemTag?.findMany === 'function' &&
          typeof client.itemTag?.deleteMany === 'function'
        ) {
          const sourceLinks = await client.itemTag.findMany({
            where: { tagId: tag.id },
            select: { itemId: true },
          });
          const targetLinks = await client.itemTag.findMany({
            where: { tagId: conflictingTag.id },
            select: { itemId: true },
          });
          const targetItemIds = new Set(targetLinks.map((l) => l.itemId));
          const missingItemIds = sourceLinks
            .map((l) => l.itemId)
            .filter((itemId) => !targetItemIds.has(itemId));

          if (
            missingItemIds.length > 0 &&
            typeof client.itemTag.createMany === 'function'
          ) {
            await client.itemTag.createMany({
              data: missingItemIds.map((itemId) => ({
                tagId: conflictingTag.id,
                itemId,
              })),
              skipDuplicates: true,
            });
          }
          await client.itemTag.deleteMany({
            where: { tagId: tag.id },
          });
        }
        await client.tag.delete({
          where: { id: tag.id },
        });
        return client.tag.update({
          where: { id: conflictingTag.id },
          data: {
            ...(data.color !== undefined ? { color: data.color } : {}),
            ...(data.type !== undefined ? { type: data.type } : {}),
          },
        });
      }
    }

    return client.tag.update({
      where: { id: tag.id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.color !== undefined ? { color: data.color } : {}),
        ...(data.type !== undefined ? { type: data.type } : {}),
      },
    });
  }

  async delete(
    userId: string,
    id: string,
    tx?: Prisma.TransactionClient,
    projectId?: string,
  ): Promise<boolean> {
    const client = this.getClient(tx);
    const where: Prisma.TagWhereInput = {
      id,
      ...(projectId && projectId !== 'user'
        ? { projectId }
        : { userId, projectId: null }),
    };
    const result = await client.tag.deleteMany({
      where,
    });
    return result.count > 0;
  }

  async deleteAutomatic(
    userId: string,
    tx?: Prisma.TransactionClient,
    projectId?: string,
  ): Promise<string[]> {
    const client = this.getClient(tx);
    const scopeWhere: Prisma.TagWhereInput =
      projectId && projectId !== 'user'
        ? { projectId }
        : { userId, projectId: null };

    await client.itemTag.deleteMany({
      where: {
        type: TagType.automatic,
        tag: scopeWhere,
      },
    });

    const automaticTags = await client.tag.findMany({
      where: {
        ...scopeWhere,
        type: TagType.automatic,
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
