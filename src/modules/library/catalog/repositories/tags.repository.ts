import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core';
import { Prisma, TagType } from '@prisma/client';
import { normalizeProjectScopeId } from '@/modules/library/core';

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
    const validProjectId = normalizeProjectScopeId(options?.projectId);
    const activeFilter = options?.includeInactive
      ? {}
      : {
          itemTags: {
            some: {
              item: { deletedAt: null },
            },
          },
        };
    const where: Prisma.TagWhereInput = validProjectId
      ? {
          projectId: validProjectId,
          ...activeFilter,
        }
      : {
          userId,
          projectId: null,
          ...activeFilter,
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
    const validProjectId = normalizeProjectScopeId(projectId);
    const scopeWhere = validProjectId
      ? { projectId: validProjectId }
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
    projectId?: string | null,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    const effectiveProjectId = normalizeProjectScopeId(projectId);
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

      try {
        return await client.tag.create({
          data: {
            userId,
            createdById: userId,
            name,
            color,
            type: resolvedType,
            projectId: effectiveProjectId,
          },
        });
      } catch (err: unknown) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002'
        ) {
          const raceTag = await client.tag.findFirst({
            where: {
              projectId: effectiveProjectId,
              name: { equals: name, mode: 'insensitive' },
            },
          });
          if (raceTag) return raceTag;
        }
        throw err;
      }
    }

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

    try {
      return await client.tag.create({
        data: {
          userId,
          createdById: userId,
          name,
          color,
          type: resolvedType,
          projectId: null,
        },
      });
    } catch (err: unknown) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const raceTag = await client.tag.findFirst({
          where: {
            userId,
            projectId: null,
            name: { equals: name, mode: 'insensitive' },
          },
        });
        if (raceTag) return raceTag;
      }
      throw err;
    }
  }

  async update(
    userId: string,
    id: string,
    data: {
      name?: string;
      color?: string;
      type?: TagType;
      shortcut?: number | null;
    },
    tx?: Prisma.TransactionClient,
    projectId?: string,
  ) {
    const client = this.getClient(tx);
    const validProjectId = normalizeProjectScopeId(projectId);
    const scopeWhere: Prisma.TagWhereInput = validProjectId
      ? { id, projectId: validProjectId }
      : { id, userId, projectId: null };

    const tag = await client.tag.findFirst({
      where: scopeWhere,
    });
    if (!tag) return null;

    if (
      typeof data.shortcut === 'number' &&
      data.shortcut >= 1 &&
      data.shortcut <= 9
    ) {
      const shortcutScopeWhere: Prisma.TagWhereInput = validProjectId
        ? {
            projectId: validProjectId,
            shortcut: data.shortcut,
            id: { not: tag.id },
          }
        : {
            userId,
            projectId: null,
            shortcut: data.shortcut,
            id: { not: tag.id },
          };
      await client.tag.updateMany({
        where: shortcutScopeWhere,
        data: { shortcut: null },
      });
    }

    if (
      data.name !== undefined &&
      data.name.trim().toLowerCase() !== tag.name.trim().toLowerCase()
    ) {
      const targetWhere: Prisma.TagWhereInput = validProjectId
        ? {
            projectId: validProjectId,
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

        if (missingItemIds.length > 0) {
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
        await client.tag.delete({
          where: { id: tag.id },
        });
        return client.tag.update({
          where: { id: conflictingTag.id },
          data: {
            ...(data.color !== undefined ? { color: data.color } : {}),
            ...(data.type !== undefined ? { type: data.type } : {}),
            ...(data.shortcut !== undefined ? { shortcut: data.shortcut } : {}),
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
        ...(data.shortcut !== undefined ? { shortcut: data.shortcut } : {}),
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
    const validProjectId = normalizeProjectScopeId(projectId);
    const where: Prisma.TagWhereInput = {
      id,
      ...(validProjectId
        ? { projectId: validProjectId }
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
    const validProjectId = normalizeProjectScopeId(projectId);
    const scopeWhere: Prisma.TagWhereInput = validProjectId
      ? { projectId: validProjectId }
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
