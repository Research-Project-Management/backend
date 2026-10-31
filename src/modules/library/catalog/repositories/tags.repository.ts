import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@/core';
import { Prisma, TagType } from '@prisma/client';
import { normalizeProjectScopeId } from '@/modules/library/core';
import { VersionMismatchException } from '@/modules/library/core/errors/domain.exception';
import { resolveOrCreateTags } from '@/modules/library/catalog/repositories/command-relations.helper';

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
    color?: string,
    type: TagType = TagType.manual,
    projectId?: string | null,
    tx?: Prisma.TransactionClient,
    shortcut?: number | null,
  ) {
    const client = this.getClient(tx);
    const effectiveProjectId = normalizeProjectScopeId(projectId);
    const resolvedType = type || TagType.manual;
    const defaultColor = color ?? '#3b82f6';

    if (effectiveProjectId) {
      const existingProjectTag = await client.tag.findFirst({
        where: {
          projectId: effectiveProjectId,
          name: { equals: name, mode: 'insensitive' },
        },
      });
      if (existingProjectTag) {
        if (
          (color !== undefined && existingProjectTag.color !== color) ||
          (shortcut !== undefined && existingProjectTag.shortcut !== shortcut)
        ) {
          return client.tag.update({
            where: { id: existingProjectTag.id },
            data: {
              ...(color !== undefined ? { color } : {}),
              ...(shortcut !== undefined ? { shortcut } : {}),
            },
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
            color: defaultColor,
            type: resolvedType,
            projectId: effectiveProjectId,
            ...(shortcut !== undefined ? { shortcut } : {}),
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
      if (
        (color !== undefined && existingPersonalTag.color !== color) ||
        (shortcut !== undefined && existingPersonalTag.shortcut !== shortcut)
      ) {
        return client.tag.update({
          where: { id: existingPersonalTag.id },
          data: {
            ...(color !== undefined ? { color } : {}),
            ...(shortcut !== undefined ? { shortcut } : {}),
          },
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
          color: defaultColor,
          type: resolvedType,
          projectId: null,
          ...(shortcut !== undefined ? { shortcut } : {}),
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
      expectedVersion?: number;
      version?: number;
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

    const expectedVersion = data.expectedVersion ?? data.version;
    if (expectedVersion !== undefined) {
      if (client.tag.updateMany) {
        const versionCheck = await client.tag.updateMany({
          where: { ...scopeWhere, version: expectedVersion },
          data: { version: { increment: 1 } },
        });
        if (versionCheck.count === 0) {
          const fresh = await client.tag.findFirst({
            where: scopeWhere,
            select: { version: true },
          });
          throw new VersionMismatchException({
            aggregateType: 'Tag',
            entityId: id,
            currentVersion: fresh?.version ?? tag.version ?? 1,
            providedVersion: expectedVersion,
          });
        }
      } else if (tag.version !== expectedVersion) {
        throw new VersionMismatchException({
          aggregateType: 'Tag',
          entityId: id,
          currentVersion: tag.version ?? 1,
          providedVersion: expectedVersion,
        });
      }
    }

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
          select: { itemId: true, type: true },
        });
        const targetLinks = await client.itemTag.findMany({
          where: { tagId: conflictingTag.id },
          select: { itemId: true },
        });
        const targetItemIds = new Set(targetLinks.map((l) => l.itemId));
        const missingLinks = sourceLinks.filter(
          (l) => !targetItemIds.has(l.itemId),
        );

        if (missingLinks.length > 0) {
          await client.itemTag.createMany({
            data: missingLinks.map((l) => ({
              tagId: conflictingTag.id,
              itemId: l.itemId,
              type: l.type ?? tag.type ?? TagType.manual,
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
        const updatedConflicting = await client.tag.update({
          where: { id: conflictingTag.id },
          data: {
            ...(data.color !== undefined ? { color: data.color } : {}),
            ...(data.type !== undefined ? { type: data.type } : {}),
            ...(data.shortcut !== undefined ? { shortcut: data.shortcut } : {}),
            version: { increment: 1 },
          },
        });
        return Object.assign(updatedConflicting, {
          _mergedFromTagId: tag.id,
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
        ...(expectedVersion !== undefined ? {} : { version: { increment: 1 } }),
      },
    });
  }

  async findItemIdsByTagIds(
    tagIds: string[],
    tx?: Prisma.TransactionClient,
  ): Promise<string[]> {
    if (!tagIds || tagIds.length === 0) return [];
    const client = this.getClient(tx);
    if (!client.itemTag?.findMany) return [];
    const rows = await client.itemTag.findMany({
      where: {
        tagId: tagIds.length === 1 ? tagIds[0] : { in: tagIds },
      },
      select: { itemId: true },
    });
    if (!Array.isArray(rows)) return [];
    return Array.from(
      new Set(rows.map((r: { itemId: string }) => r.itemId).filter(Boolean)),
    );
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

  async verifyTagAndItemInScope(
    userId: string,
    tagId: string,
    itemId: string,
    projectId?: string,
    tx?: Prisma.TransactionClient,
  ): Promise<{ tagFound: boolean; itemFound: boolean }> {
    const client = this.getClient(tx);
    const effectiveProjectId = normalizeProjectScopeId(projectId);
    const tagWhere: Prisma.TagWhereInput = effectiveProjectId
      ? { id: tagId, projectId: effectiveProjectId }
      : { id: tagId, userId, projectId: null };
    const itemWhere: Prisma.ItemWhereInput = effectiveProjectId
      ? { id: itemId, projectId: effectiveProjectId, deletedAt: null }
      : { id: itemId, userId, projectId: null, deletedAt: null };

    const [tag, item] = await Promise.all([
      client.tag.findFirst({
        where: tagWhere,
        select: { id: true },
      }),
      client.item.findFirst({
        where: itemWhere,
        select: { id: true },
      }),
    ]);

    return { tagFound: Boolean(tag), itemFound: Boolean(item) };
  }

  async assignTagToItem(
    userId: string,
    tagId: string,
    itemId: string,
    projectId?: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const { tagFound, itemFound } = await this.verifyTagAndItemInScope(
      userId,
      tagId,
      itemId,
      projectId,
      tx,
    );
    if (!tagFound) {
      throw new NotFoundException(`Tag ${tagId} not found in library`);
    }
    if (!itemFound) {
      throw new NotFoundException(`Item ${itemId} not found in library`);
    }
    await this.assignToItem(tagId, itemId, tx);
  }

  async removeTagFromItem(
    userId: string,
    tagId: string,
    itemId: string,
    projectId?: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const { tagFound, itemFound } = await this.verifyTagAndItemInScope(
      userId,
      tagId,
      itemId,
      projectId,
      tx,
    );
    if (!tagFound) {
      throw new NotFoundException(`Tag ${tagId} not found in library`);
    }
    if (!itemFound) {
      throw new NotFoundException(`Item ${itemId} not found in library`);
    }
    await this.removeFromItem(tagId, itemId, tx);
  }

  async syncItemTags(
    userId: string,
    itemId: string,
    tagNames: string[],
    defaultTagType: TagType = TagType.automatic,
    projectId?: string,
    tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    if (tagNames.length === 0) return false;
    const client = this.getClient(tx);
    const resolvedTags = await resolveOrCreateTags(
      client,
      userId,
      tagNames,
      defaultTagType,
      normalizeProjectScopeId(projectId),
    );
    if (resolvedTags.length === 0) return false;

    await client.itemTag.createMany({
      data: resolvedTags.map((tag) => ({
        tagId: tag.id,
        itemId,
        type: tag.type,
      })),
      skipDuplicates: true,
    });
    return true;
  }

  async mergeTagsIntoTarget(
    sourceItemIds: string[],
    targetItemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    if (sourceItemIds.length === 0) return;
    const client = this.getClient(tx);
    const [primaryTags, dupTags] = await Promise.all([
      client.itemTag.findMany({
        where: { itemId: targetItemId },
        select: { tagId: true },
      }),
      client.itemTag.findMany({
        where: { itemId: { in: sourceItemIds } },
        select: { tagId: true },
      }),
    ]);
    const primaryTagIds = new Set(primaryTags.map((it) => it.tagId));
    const newTagIds = Array.from(
      new Set(
        dupTags
          .map((dup) => dup.tagId)
          .filter((tagId) => !primaryTagIds.has(tagId)),
      ),
    );

    if (newTagIds.length > 0) {
      await client.itemTag.createMany({
        data: newTagIds.map((tagId) => ({
          itemId: targetItemId,
          tagId,
        })),
        skipDuplicates: true,
      });
    }

    await client.itemTag.deleteMany({
      where: { itemId: { in: sourceItemIds } },
    });
  }
}
