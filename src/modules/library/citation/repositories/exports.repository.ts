import { Injectable } from '@nestjs/common';
import { PrismaService, isUuid } from '@/core';
import { Prisma } from '@prisma/client';
import { normalizeProjectScopeId } from '@/modules/library/core';
import {
  EXPORT_CHUNK_SIZE,
  EXPORT_MAX_ITEMS,
  ExportItemRecord,
} from '../types/citation.types';

export { EXPORT_CHUNK_SIZE, EXPORT_MAX_ITEMS };
export type { ExportItemRecord };

/**
 * ExportsRepository — CQRS Read-Side Optimized Data Store for Bulk Citation Export & Custom CSL Styles.
 * Serves read-only projection streaming to prevent N+1 queries across thousands of items.
 */
@Injectable()
export class ExportsRepository {
  constructor(private readonly prisma: PrismaService) {}

  private normalizeScopeToSpaceId(scopeKey: string, userId?: string, projectId?: string): string {
    const rawProjectId =
      projectId ||
      (scopeKey.startsWith('proj:') ? scopeKey.slice(5) : null);
    if (rawProjectId && isUuid(rawProjectId)) return rawProjectId;
    const rawUserId =
      userId ||
      (scopeKey.startsWith('user:') ? scopeKey.slice(5) : !scopeKey.startsWith('proj:') && isUuid(scopeKey) ? scopeKey : null);
    if (rawUserId && isUuid(rawUserId)) return rawUserId;
    return scopeKey;
  }

  async findCustomStyle(scopeKey: string, slug: string) {
    if (!this.prisma?.citationStyle?.findUnique) return null;
    const spaceId = this.normalizeScopeToSpaceId(scopeKey);
    return this.prisma.citationStyle.findUnique({
      where: { spaceId_slug: { spaceId, slug } },
    });
  }

  async upsertCustomStyle(params: {
    scopeKey: string;
    slug: string;
    title: string;
    xmlContent: string;
    sha256: string;
    userId?: string;
    projectId?: string;
  }) {
    if (!this.prisma?.citationStyle?.upsert) return null;
    const { scopeKey, slug, title, xmlContent, sha256 } = params;
    const spaceId = this.normalizeScopeToSpaceId(scopeKey, params.userId, params.projectId);
    const rawUserId =
      params.userId ||
      (scopeKey.startsWith('user:') ? scopeKey.slice(5) : !scopeKey.startsWith('proj:') && isUuid(scopeKey) ? scopeKey : null);
    const safeUserId =
      rawUserId && isUuid(rawUserId)
        ? rawUserId
        : '00000000-0000-0000-0000-000000000000';
    return this.prisma.citationStyle.upsert({
      where: { spaceId_slug: { spaceId, slug } },
      create: {
        spaceId,
        createdById: safeUserId,
        slug,
        title,
        xmlContent,
        sha256,
      },
      update: {
        title,
        xmlContent,
        sha256,
      },
    });
  }

  async findCustomStylesByScope(scopeKey: string, take: number = 100) {
    if (!this.prisma?.citationStyle?.findMany) return [];
    const spaceId = this.normalizeScopeToSpaceId(scopeKey);
    return this.prisma.citationStyle.findMany({
      where: { spaceId },
      orderBy: { updatedAt: 'desc' },
      take,
    });
  }

  async fetchItemsInChunks(
    where: Prisma.LibraryItemWhereInput,
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

      const chunk = await this.prisma.libraryItem.findMany({
        where,
        include: {
          contributors: { orderBy: { orderIndex: 'asc' } },
          itemTags: { include: { tag: true } },
          notesList: { where: { deletedAt: null } },
          identifiers: true,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
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
    const [member, ownedProject] = await Promise.all([
      this.prisma.projectMember.findUnique({
        where: {
          projectId_userId: { projectId, userId },
        },
        select: { role: true },
      }),
      this.prisma.project.findFirst({
        where: { id: projectId, createdById: userId, deletedAt: null },
        select: { id: true },
      }),
    ]);
    if (member) return member;
    if (ownedProject) {
      return { role: 'OWNER' as const };
    }
    return null;
  }

  async findCollection(collectionId: string) {
    return this.prisma.libraryCollection.findFirst({
      where: { id: collectionId, deletedAt: null },
      select: { id: true, name: true, spaceId: true, createdById: true },
    });
  }

  async findItems(where: Prisma.LibraryItemWhereInput, take?: number) {
    return this.prisma.libraryItem.findMany({
      where,
      include: {
        contributors: { orderBy: { orderIndex: 'asc' } },
        attachments: { where: { deletedAt: null } },
        itemTags: { include: { tag: true } },
        notesList: { where: { deletedAt: null } },
        identifiers: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...(take ? { take } : {}),
    });
  }


  async findItemById(userId: string, itemId: string, projectId?: string) {
    const effectiveProjectId = normalizeProjectScopeId(projectId);
    const scopeWhere: Prisma.LibraryItemWhereInput = {
      spaceId: effectiveProjectId || userId,
    };
    return this.prisma.libraryItem.findFirst({
      where: {
        id: itemId,
        deletedAt: null,
        ...scopeWhere,
      },
      include: {
        contributors: { orderBy: { orderIndex: 'asc' } },
        itemTags: { include: { tag: true } },
        notesList: { where: { deletedAt: null } },
        identifiers: true,
        attachments: {
          where: { deletedAt: null },
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
    scopeWhere: Prisma.LibraryItemWhereInput,
    take: number = EXPORT_MAX_ITEMS,
  ) {
    return this.prisma.libraryItem.findMany({
      where: scopeWhere,
      include: {
        contributors: { orderBy: { orderIndex: 'asc' } },
        itemTags: { include: { tag: true } },
        notesList: { where: { deletedAt: null } },
        identifiers: true,
      },
      take,
    });
  }

  async findItemsByMetadataAliases(
    scopeWhere: Prisma.LibraryItemWhereInput,
    missingKeys: string[],
  ): Promise<ExportItemRecord[]> {
    if (!missingKeys || missingKeys.length === 0) return [];
    const CHUNK_SIZE = 50;
    const MAX_RESULTS = 500;
    const collectedById = new Map<string, ExportItemRecord>();

    for (let i = 0; i < missingKeys.length; i += CHUNK_SIZE) {
      if (collectedById.size >= MAX_RESULTS) break;
      const chunkKeys = missingKeys.slice(i, i + CHUNK_SIZE);
      const aliasClauses: Prisma.LibraryItemWhereInput[] = chunkKeys.flatMap((key) => [
        { metadata: { path: ['mergedCitationKeys'], array_contains: key } },
        { metadata: { path: ['citationKey'], equals: key } },
        { metadata: { path: ['citation-key'], equals: key } },
        { metadata: { path: ['tex.ids'], string_contains: key } },
        { metadata: { path: ['extra'], string_contains: key } },
      ]);

      const batchItems = await this.prisma.libraryItem.findMany({
        where: {
          AND: [scopeWhere, { OR: aliasClauses }],
        },
        include: {
          contributors: { orderBy: { orderIndex: 'asc' } },
          itemTags: { include: { tag: true } },
          notesList: { where: { deletedAt: null } },
          identifiers: true,
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
