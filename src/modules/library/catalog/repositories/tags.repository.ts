import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@/core';
import { Prisma, TagType } from '@prisma/client';
import { normalizeProjectScopeId, resolveSpaceId } from '@/modules/library/core';
import { VersionMismatchException } from '@/modules/library/core/errors/domain.exception';
import { resolveOrCreateTags } from '@/modules/library/catalog/repositories/command-relations.operations';

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
    const activeFilter: Prisma.LibraryTagWhereInput = options?.includeInactive
      ? {}
      : {
          OR: [
            { type: TagType.manual },
            {
              itemTags: {
                some: {
                  item: { deletedAt: null },
                },
              },
            },
          ],
        };
    const where: Prisma.LibraryTagWhereInput = {
      spaceId: resolveSpaceId({ userId, projectId: validProjectId }),
      ...activeFilter,
    };

    return client.libraryTag.findMany({
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
    const spaceId = resolveSpaceId({ userId, projectId: effectiveProjectId });
    const normalizedName = name.trim().toLowerCase();
    const resolvedType = type || TagType.manual;
    const defaultColor = color ?? '#3b82f6';
    const scopeWhere: Prisma.LibraryTagWhereInput = { spaceId };

    const existingTag = await client.libraryTag.findFirst({
      where: {
        ...scopeWhere,
        name: { equals: name, mode: 'insensitive' },
      },
    });

    if (existingTag) {
      if (
        (color !== undefined && existingTag.color !== color) ||
        (shortcut !== undefined && existingTag.shortcut !== shortcut)
      ) {
        return client.libraryTag.update({
          where: { id: existingTag.id },
          data: {
            ...(color !== undefined ? { color } : {}),
            ...(shortcut !== undefined ? { shortcut } : {}),
            version: { increment: 1 },
          },
        });
      }
      return existingTag;
    }

    const tagData = {
      spaceId,
      createdById: userId,
      name,
      normalizedName,
      color: defaultColor,
      type: resolvedType,
      ...(shortcut !== undefined ? { shortcut } : {}),
    };

    if (client.libraryTag?.upsert) {
      return client.libraryTag.upsert({
        where: { spaceId_normalizedName: { spaceId, normalizedName } },
        update: {},
        create: tagData,
      });
    }

    try {
      return await client.libraryTag.create({ data: tagData });
    } catch (err: unknown) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const raceTag = await client.libraryTag.findFirst({
          where: {
            ...scopeWhere,
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
    const spaceId = resolveSpaceId({ userId, projectId: validProjectId });
    const scopeWhere: Prisma.LibraryTagWhereInput = { id, spaceId };

    const tag = await client.libraryTag.findFirst({
      where: scopeWhere,
    });
    if (!tag) return null;

    const expectedVersion = data.expectedVersion ?? data.version;
    if (expectedVersion !== undefined && tag.version !== expectedVersion) {
      throw new VersionMismatchException({
        aggregateType: 'Tag',
        entityId: id,
        currentVersion: tag.version ?? 1,
        providedVersion: expectedVersion,
      });
    }

    if (
      typeof data.shortcut === 'number' &&
      data.shortcut >= 1 &&
      data.shortcut <= 9
    ) {
      const shortcutScopeWhere: Prisma.LibraryTagWhereInput = {
        spaceId,
        shortcut: data.shortcut,
        id: { not: tag.id },
      };
      await client.libraryTag.updateMany({
        where: shortcutScopeWhere,
        data: { shortcut: null },
      });
    }

    if (
      data.name !== undefined &&
      data.name.trim().toLowerCase() !== tag.name.trim().toLowerCase()
    ) {
      const targetWhere: Prisma.LibraryTagWhereInput = {
        spaceId,
        id: { not: tag.id },
        name: { equals: data.name, mode: 'insensitive' },
      };
      const conflictingTag = await client.libraryTag.findFirst({
        where: targetWhere,
      });

      if (conflictingTag) {
        const [sourceLinks, targetLinks] = await Promise.all([
          client.libraryItemTag.findMany({
            where: { tagId: tag.id },
            select: { itemId: true, type: true },
          }),
          client.libraryItemTag.findMany({
            where: { tagId: conflictingTag.id },
            select: { itemId: true },
          }),
        ]);
        const targetItemIds = new Set(targetLinks.map((l) => l.itemId));
        const missingLinks = sourceLinks.filter(
          (l) => !targetItemIds.has(l.itemId),
        );

        await Promise.all([
          missingLinks.length > 0
            ? client.libraryItemTag.createMany({
                data: missingLinks.map((l) => ({
                  tagId: conflictingTag.id,
                  itemId: l.itemId,
                  type: l.type ?? tag.type ?? TagType.manual,
                })),
                skipDuplicates: true,
              })
            : Promise.resolve(),
          client.libraryItemTag.deleteMany({
            where: { tagId: tag.id },
          }),
        ]);
        const [, updatedConflicting] = await Promise.all([
          client.libraryTag.delete({
            where: { id: tag.id },
          }),
          client.libraryTag.update({
            where: { id: conflictingTag.id },
            data: {
              ...(data.color !== undefined ? { color: data.color } : {}),
              ...(data.type !== undefined ? { type: data.type } : {}),
              ...(data.shortcut !== undefined ? { shortcut: data.shortcut } : {}),
              version: { increment: 1 },
            },
          }),
        ]);
        return Object.assign(updatedConflicting, {
          _mergedFromTagId: tag.id,
        });
      }
    }

    const updatePayload: Prisma.LibraryTagUpdateInput = {
      ...(data.name !== undefined
        ? {
            name: data.name,
            normalizedName: data.name.trim().toLowerCase(),
          }
        : {}),
      ...(data.color !== undefined ? { color: data.color } : {}),
      ...(data.type !== undefined ? { type: data.type } : {}),
      ...(data.shortcut !== undefined ? { shortcut: data.shortcut } : {}),
      version: { increment: 1 },
    };

    if (expectedVersion !== undefined && client.libraryTag.updateMany) {
      const affected = await client.libraryTag.updateMany({
        where: { ...scopeWhere, version: expectedVersion },
        data: updatePayload,
      });
      if (affected.count === 0) {
        const fresh = await client.libraryTag.findFirst({
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
      return {
        ...tag,
        ...(data.name !== undefined
          ? {
              name: data.name,
              normalizedName: data.name.trim().toLowerCase(),
            }
          : {}),
        ...(data.color !== undefined ? { color: data.color } : {}),
        ...(data.type !== undefined ? { type: data.type } : {}),
        ...(data.shortcut !== undefined ? { shortcut: data.shortcut } : {}),
        version: (tag.version ?? 1) + 1,
        updatedAt: new Date(),
      };
    }

    return client.libraryTag.update({
      where: { id: tag.id },
      data: updatePayload,
    });
  }

  async findItemIdsByTagIds(
    tagIds: string[],
    tx?: Prisma.TransactionClient,
  ): Promise<string[]> {
    if (!tagIds || tagIds.length === 0) return [];
    const client = this.getClient(tx);
    if (!client.libraryItemTag?.findMany) return [];
    const rows = await client.libraryItemTag.findMany({
      where: {
        tagId: tagIds.length === 1 ? tagIds[0] : { in: tagIds },
        item: { deletedAt: null },
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
    const where: Prisma.LibraryTagWhereInput = {
      id,
      spaceId: resolveSpaceId({ userId, projectId: validProjectId }),
    };
    const result = await client.libraryTag.deleteMany({
      where,
    });
    return result.count > 0;
  }

  async findAutomaticTagItemIds(
    userId: string,
    tx?: Prisma.TransactionClient,
    projectId?: string,
  ): Promise<string[]> {
    const client = this.getClient(tx);
    const validProjectId = normalizeProjectScopeId(projectId);
    const scopeWhere: Prisma.LibraryTagWhereInput = {
      spaceId: resolveSpaceId({ userId, projectId: validProjectId }),
    };
    const links = await client.libraryItemTag.findMany({
      where: {
        item: { deletedAt: null },
        OR: [
          { type: TagType.automatic, tag: scopeWhere },
          { tag: { ...scopeWhere, type: TagType.automatic } },
        ],
      },
      select: { itemId: true },
    });
    return Array.from(new Set(links.map((l) => l.itemId)));
  }

  async deleteAutomatic(
    userId: string,
    tx?: Prisma.TransactionClient,
    projectId?: string,
  ): Promise<string[]> {
    const client = this.getClient(tx);
    const validProjectId = normalizeProjectScopeId(projectId);
    const scopeWhere: Prisma.LibraryTagWhereInput = {
      spaceId: resolveSpaceId({ userId, projectId: validProjectId }),
    };

    const autoItemTags = client.libraryItemTag?.findMany
      ? (await client.libraryItemTag.findMany({
          where: {
            type: TagType.automatic,
            tag: scopeWhere,
          },
          select: { tagId: true },
        })) || []
      : [];
    const affectedAutoTagIds = Array.from(
      new Set(autoItemTags.map((it) => it.tagId).filter(Boolean)),
    );

    await client.libraryItemTag.deleteMany({
      where: {
        type: TagType.automatic,
        tag: scopeWhere,
      },
    });

    if (typeof client.libraryTag?.updateMany === 'function') {
      await client.libraryTag.updateMany({
        where: {
          ...scopeWhere,
          type: TagType.automatic,
          itemTags: { some: {} },
        },
        data: {
          type: TagType.manual,
        },
      });
    }

    const automaticTagsToDelete =
      (await client.libraryTag.findMany({
        where: {
          ...scopeWhere,
          type: TagType.automatic,
          itemTags: { none: {} },
        },
        select: { id: true },
      })) || [];
    const deletedTagIds = automaticTagsToDelete.map((t) => t.id);

    if (deletedTagIds.length > 0) {
      await client.libraryTag.deleteMany({
        where: { id: { in: deletedTagIds } },
      });
    }

    return deletedTagIds;
  }

  async assignToItem(
    tagId: string,
    itemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = this.getClient(tx);
    await Promise.all([
      client.libraryItemTag.upsert({
        where: {
          tagId_itemId: {
            tagId,
            itemId,
          },
        },
        create: {
          tagId,
          itemId,
          type: TagType.manual,
        },
        update: {
          type: TagType.manual,
        },
      }),
      typeof client.libraryTag?.updateMany === 'function'
        ? client.libraryTag.updateMany({
            where: { id: tagId, type: TagType.automatic },
            data: { type: TagType.manual },
          })
        : Promise.resolve(),
    ]);
  }

  async removeFromItem(
    tagId: string,
    itemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = this.getClient(tx);
    await client.libraryItemTag.deleteMany({
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
    const spaceId = resolveSpaceId({ userId, projectId: effectiveProjectId });
    const tagWhere: Prisma.LibraryTagWhereInput = { id: tagId, spaceId };
    const itemWhere: Prisma.LibraryItemWhereInput = {
      id: itemId,
      spaceId,
      deletedAt: null,
    };

    const [tag, item] = await Promise.all([
      client.libraryTag.findFirst({
        where: tagWhere,
        select: { id: true },
      }),
      client.libraryItem.findFirst({
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

    await client.libraryItemTag.createMany({
      data: [...resolvedTags]
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((tag) => ({
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
      client.libraryItemTag.findMany({
        where: { itemId: targetItemId },
        select: { tagId: true, type: true },
      }),
      client.libraryItemTag.findMany({
        where: { itemId: { in: sourceItemIds } },
        select: { tagId: true, type: true },
      }),
    ]);
    const primaryTagTypeMap = new Map<string, TagType>();
    for (const pt of primaryTags) {
      primaryTagTypeMap.set(pt.tagId, pt.type ?? TagType.manual);
    }

    const dupTagTypeMap = new Map<string, TagType>();
    for (const dup of dupTags) {
      const existingType = dupTagTypeMap.get(dup.tagId);
      const dupType = dup.type ?? TagType.manual;
      if (!existingType || dupType === TagType.manual) {
        dupTagTypeMap.set(dup.tagId, dupType);
      }
    }

    const newEntries: Array<{ itemId: string; tagId: string; type: TagType }> = [];
    const upgradeTagIds: string[] = [];

    for (const [tagId, dupType] of dupTagTypeMap.entries()) {
      const primaryType = primaryTagTypeMap.get(tagId);
      if (primaryType === undefined) {
        newEntries.push({
          itemId: targetItemId,
          tagId,
          type: dupType,
        });
      } else if (
        primaryType === TagType.automatic &&
        dupType === TagType.manual
      ) {
        upgradeTagIds.push(tagId);
      }
    }

    newEntries.sort((a, b) => (a.tagId < b.tagId ? -1 : a.tagId > b.tagId ? 1 : 0));
    upgradeTagIds.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    await Promise.all([
      newEntries.length > 0
        ? client.libraryItemTag.createMany({ data: newEntries, skipDuplicates: true })
        : Promise.resolve(),
      upgradeTagIds.length > 0 && typeof client.libraryItemTag.updateMany === 'function'
        ? client.libraryItemTag.updateMany({
            where: {
              itemId: targetItemId,
              tagId: { in: upgradeTagIds },
              type: TagType.automatic,
            },
            data: { type: TagType.manual },
          })
        : Promise.resolve(),
      client.libraryItemTag.deleteMany({
        where: { itemId: { in: sourceItemIds } },
      }),
    ]);
  }

  async splitTag(
    userId: string,
    tagId: string,
    parts: string[],
    tx?: Prisma.TransactionClient,
    projectId?: string,
  ) {
    const client = this.getClient(tx);
    const validProjectId = normalizeProjectScopeId(projectId);
    const spaceId = resolveSpaceId({ userId, projectId: validProjectId });
    const scopeWhere: Prisma.LibraryTagWhereInput = { id: tagId, spaceId };

    const sourceTag = await client.libraryTag.findFirst({ where: scopeWhere });
    if (!sourceTag) return null;

    const sourceLinks = await client.libraryItemTag.findMany({
      where: { tagId: sourceTag.id, item: { deletedAt: null } },
      select: { itemId: true, type: true },
    });
    const affectedItemIds = Array.from(new Set(sourceLinks.map((l) => l.itemId)));

    const firstTag = await this.update(
      userId,
      sourceTag.id,
      { name: parts[0] },
      tx,
      validProjectId,
    );
    const resultTags = firstTag ? [firstTag] : [];

    for (const partName of parts.slice(1)) {
      const targetTag = await this.create(
        userId,
        partName,
        sourceTag.color ?? undefined,
        sourceTag.type,
        validProjectId,
        tx,
      );
      if (targetTag) {
        resultTags.push(targetTag);
        if (sourceLinks.length > 0 && targetTag.id !== firstTag?.id) {
          await client.libraryItemTag.createMany({
            data: sourceLinks.map((l) => ({
              tagId: targetTag.id,
              itemId: l.itemId,
              type: l.type ?? sourceTag.type ?? TagType.manual,
            })),
            skipDuplicates: true,
          });
        }
      }
    }

    return {
      tags: resultTags,
      affectedItemIds,
      mergedFromTagId: (firstTag as { _mergedFromTagId?: string } | null)?._mergedFromTagId,
    };
  }
}
