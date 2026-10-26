import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core';
import { Prisma } from '@prisma/client';
import { normalizeProjectScopeId } from '@/modules/library/core';

/** Maximum number of items exported in a single request. */
export const EXPORT_MAX_ITEMS = 1000;
/** Cursor-page size used when fetching from the DB. */
export const EXPORT_CHUNK_SIZE = 200;

export type ExportItemRecord = Prisma.ItemGetPayload<{
  include: { contributors: { orderBy: { orderIndex: 'asc' } } };
}>;

/**
 * ExportsRepository — CQRS Read-Side Optimized Data Store for Bulk Citation Export.
 * Serves read-only projection streaming to prevent N+1 queries across thousands of items.
 */
@Injectable()
export class ExportsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async fetchItemsInChunks(
    where: Prisma.ItemWhereInput,
    maxItems: number = EXPORT_MAX_ITEMS,
    chunkSize: number = EXPORT_CHUNK_SIZE,
  ): Promise<{ items: ExportItemRecord[]; truncated: boolean }> {
    const collected: ExportItemRecord[] = [];
    let cursor: string | undefined;
    let truncated = false;

    while (collected.length < maxItems) {
      const remaining = maxItems - collected.length;
      const pageSize = Math.min(chunkSize, remaining);
      const take = pageSize + 1;

      const chunk = await this.prisma.item.findMany({
        where,
        include: {
          contributors: { orderBy: { orderIndex: 'asc' } },
        },
        orderBy: { createdAt: 'desc' },
        take,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });

      const hasMore = chunk.length > pageSize;
      if (hasMore) {
        chunk.pop();
      }

      collected.push(...chunk);

      if (chunk.length === 0) break;

      if (hasMore && remaining <= chunkSize) {
        truncated = true;
        break;
      }

      if (!hasMore) break;

      cursor = chunk[chunk.length - 1].id;
    }

    return { items: collected, truncated };
  }

  async findProjectMember(projectId: string, userId: string) {
    const member = await this.prisma.projectMember.findUnique({
      where: {
        projectId_userId: { projectId, userId },
      },
      select: { role: true },
    });
    if (member) return member;
    const ownedProject = await this.prisma.project.findFirst({
      where: { id: projectId, createdById: userId, deletedAt: null },
      select: { id: true },
    });
    if (ownedProject) {
      return { role: 'OWNER' as const };
    }
    return null;
  }

  async findCollection(collectionId: string) {
    return this.prisma.collection.findFirst({
      where: { id: collectionId, deletedAt: null },
      select: { id: true, name: true, userId: true, projectId: true },
    });
  }

  async findItems(where: Prisma.ItemWhereInput, take?: number) {
    return this.prisma.item.findMany({
      where,
      include: {
        contributors: { orderBy: { orderIndex: 'asc' } },
        attachments: { where: { deletedAt: null } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...(take ? { take } : {}),
    });
  }

  async findItemsByIds(
    scopeWhere: Prisma.ItemWhereInput,
    itemIds: string[],
    collectionId?: string,
    take: number = EXPORT_MAX_ITEMS,
  ) {
    return this.prisma.item.findMany({
      where: {
        ...scopeWhere,
        id: { in: itemIds },
        ...(collectionId
          ? { collectionItems: { some: { collectionId } } }
          : {}),
      },
      include: {
        contributors: { orderBy: { orderIndex: 'asc' } },
        attachments: { where: { deletedAt: null } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
    });
  }

  async findItemById(userId: string, itemId: string, projectId?: string) {
    const effectiveProjectId = normalizeProjectScopeId(projectId);
    const scopeWhere: Prisma.ItemWhereInput = effectiveProjectId
      ? { projectId: effectiveProjectId }
      : { userId, projectId: null };
    return this.prisma.item.findFirst({
      where: {
        id: itemId,
        deletedAt: null,
        ...scopeWhere,
      },
      include: {
        contributors: { orderBy: { orderIndex: 'asc' } },
        attachments: {
          include: {
            annotations: {
              where: { deletedAt: null },
            },
          },
        },
      },
    });
  }

  async findItemsByScope(
    scopeWhere: Prisma.ItemWhereInput,
    take: number = EXPORT_MAX_ITEMS,
  ) {
    return this.prisma.item.findMany({
      where: scopeWhere,
      include: {
        contributors: { orderBy: { orderIndex: 'asc' } },
      },
      take,
    });
  }

  async findItemsByMetadataAliases(
    scopeWhere: Prisma.ItemWhereInput,
    missingKeys: string[],
  ): Promise<ExportItemRecord[]> {
    if (!missingKeys || missingKeys.length === 0) return [];
    const CHUNK_SIZE = 50;
    const MAX_RESULTS = 500;
    const collectedById = new Map<string, ExportItemRecord>();

    for (let i = 0; i < missingKeys.length; i += CHUNK_SIZE) {
      if (collectedById.size >= MAX_RESULTS) break;
      const chunkKeys = missingKeys.slice(i, i + CHUNK_SIZE);
      const aliasClauses: Prisma.ItemWhereInput[] = chunkKeys.flatMap((key) => [
        { metadata: { path: ['mergedCitationKeys'], array_contains: key } },
        { metadata: { path: ['citationKey'], equals: key } },
        { metadata: { path: ['citation-key'], equals: key } },
        { metadata: { path: ['tex.ids'], string_contains: key } },
        { metadata: { path: ['extra'], string_contains: key } },
      ]);

      const batchItems = await this.prisma.item.findMany({
        where: {
          AND: [scopeWhere, { OR: aliasClauses }],
        },
        include: {
          contributors: { orderBy: { orderIndex: 'asc' } },
        },
        take: Math.min(500, MAX_RESULTS - collectedById.size),
      });

      for (const item of batchItems) {
        if (item?.id && !collectedById.has(item.id)) {
          collectedById.set(item.id, item);
        }
      }
    }

    return Array.from(collectedById.values());
  }
}
