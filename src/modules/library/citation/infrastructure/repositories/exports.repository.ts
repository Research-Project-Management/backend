import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../../core/database/prisma.service';

/** Maximum number of items exported in a single request. */
export const EXPORT_MAX_ITEMS = 1000;
/** Cursor-page size used when fetching from the DB. */
export const EXPORT_CHUNK_SIZE = 200;

@Injectable()
export class ExportsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async fetchItemsInChunks(
    where: any,
    maxItems: number = EXPORT_MAX_ITEMS,
    chunkSize: number = EXPORT_CHUNK_SIZE,
  ): Promise<{ items: any[]; truncated: boolean }> {
    const collected: any[] = [];
    let cursor: string | undefined;
    let truncated = false;

    while (collected.length < maxItems) {
      const remaining = maxItems - collected.length;
      const pageSize = Math.min(chunkSize, remaining);
      const take = pageSize + 1; // +1 sentinel to detect if DB has more rows than this page

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
        chunk.pop(); // discard sentinel
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
    return this.prisma.projectMember.findUnique({
      where: {
        projectId_userId: { projectId, userId },
      },
      select: { role: true },
    });
  }

  async findCollection(collectionId: string) {
    return this.prisma.collection.findFirst({
      where: { id: collectionId, deletedAt: null },
      select: { id: true, name: true, userId: true, projectId: true },
    });
  }

  async findItems(where: any, take?: number) {
    return this.prisma.item.findMany({
      where,
      include: { contributors: { orderBy: { orderIndex: 'asc' } } },
      orderBy: { createdAt: 'desc' },
      ...(take ? { take } : {}),
    });
  }

  async findItemById(userId: string, itemId: string, projectId?: string) {
    return this.prisma.item.findFirst({
      where: {
        id: itemId,
        deletedAt: null,
        ...(projectId ? { projectId } : { userId }),
      },
      include: {
        contributors: { orderBy: { orderIndex: 'asc' } },
      },
    });
  }

  async findItemsByScope(scopeWhere: any) {
    return this.prisma.item.findMany({
      where: scopeWhere,
      include: {
        contributors: { orderBy: { orderIndex: 'asc' } },
      },
    });
  }
}
