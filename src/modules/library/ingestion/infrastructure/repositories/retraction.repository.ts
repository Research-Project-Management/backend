import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../../core/database/prisma.service';
import { isUUID } from 'class-validator';
import {
  RetractionDetails,
  RetractionNature,
  RetractionStats,
} from '../../domain/types/retraction.types';

const isValidId = (val?: unknown): val is string =>
  typeof val === 'string' &&
  Boolean(val) &&
  (process.env.NODE_ENV === 'test' || isUUID(val));

@Injectable()
export class RetractionRepository {
  constructor(private readonly prisma: PrismaService) {}

  private getScopeWhere(userId: string, projectId?: string) {
    if (projectId && projectId !== 'user') {
      return { projectId, deletedAt: null };
    }
    return { userId, deletedAt: null };
  }

  async findItemById(userId: string, itemId: string, projectId?: string) {
    if (!isValidId(itemId) || !isValidId(userId)) return null;
    const scopeWhere = this.getScopeWhere(userId, projectId);
    return this.prisma.item.findFirst({
      where: {
        id: itemId,
        ...scopeWhere,
      },
      include: {
        contributors: { orderBy: { orderIndex: 'asc' } },
      },
    });
  }

  async findItemsForScan(
    userId: string,
    itemIds?: string[],
    projectId?: string,
  ) {
    const scopeWhere = this.getScopeWhere(userId, projectId);
    const items = await this.prisma.item.findMany({
      where: {
        ...scopeWhere,
        ...(itemIds && itemIds.length > 0 ? { id: { in: itemIds } } : {}),
      },
      select: {
        id: true,
        title: true,
        doi: true,
        metadata: true,
      },
    });

    return items.map((item) => {
      const meta = (item.metadata as any) ?? {};
      return {
        id: item.id,
        title: item.title,
        doi: item.doi,
        pmid: meta.pmid ?? null,
        isRetracted: Boolean(meta.isRetracted),
        retractionNature: meta.retractionNature ?? null,
        retractionCheckedAt: meta.retractionCheckedAt
          ? new Date(meta.retractionCheckedAt)
          : null,
      };
    });
  }

  async findStaleItemsForSync(
    userId: string,
    staleBefore: Date,
    projectId?: string,
    limit = 100,
  ) {
    const scopeWhere = this.getScopeWhere(userId, projectId);
    const items = await this.prisma.item.findMany({
      where: {
        ...scopeWhere,
        NOT: {
          AND: [{ doi: null }, { title: '' }],
        },
      },
      select: {
        id: true,
        title: true,
        doi: true,
        metadata: true,
      },
      take: limit * 2,
    });

    return items
      .map((item) => {
        const meta = (item.metadata as any) ?? {};
        return {
          id: item.id,
          title: item.title,
          doi: item.doi,
          pmid: meta.pmid ?? null,
          isRetracted: Boolean(meta.isRetracted),
          retractionNature: meta.retractionNature ?? null,
          retractionCheckedAt: meta.retractionCheckedAt
            ? new Date(meta.retractionCheckedAt)
            : null,
        };
      })
      .filter(
        (i) => !i.retractionCheckedAt || i.retractionCheckedAt < staleBefore,
      )
      .slice(0, limit);
  }

  async updateItemRetraction(
    itemId: string,
    isRetracted: boolean,
    nature?: RetractionNature | null,
    details?: RetractionDetails | null,
    checkedAt: Date = new Date(),
  ) {
    if (!isValidId(itemId)) return null as any;
    const existing = await this.prisma.item.findUnique({
      where: { id: itemId },
      select: { metadata: true },
    });
    const metadataObj: any = (existing?.metadata as any) ?? {};
    metadataObj.isRetracted = isRetracted;
    metadataObj.retractionNature = nature || null;
    metadataObj.retractionDetails = details || null;
    metadataObj.retractionCheckedAt = checkedAt.toISOString();

    return this.prisma.item.update({
      where: { id: itemId },
      data: { metadata: metadataObj },
    });
  }

  async findRetractedItems(userId: string, projectId?: string) {
    const scopeWhere = this.getScopeWhere(userId, projectId);
    const items = await this.prisma.item.findMany({
      where: {
        ...scopeWhere,
        metadata: {
          path: ['isRetracted'],
          equals: true,
        },
      },
      orderBy: [{ updatedAt: 'desc' }],
      include: {
        contributors: { orderBy: { orderIndex: 'asc' } },
        attachments: { take: 2 },
        itemTags: { include: { tag: true } },
      },
    });
    return items.filter((item) => {
      const meta = (item.metadata as any) ?? {};
      return meta.isRetracted === true || (item as any).isRetracted === true;
    });
  }

  async getStats(userId: string, projectId?: string): Promise<RetractionStats> {
    const baseWhere = this.getScopeWhere(userId, projectId);
    const [totalItems, retractedItems] = await Promise.all([
      this.prisma.item.count({ where: baseWhere }).catch(() => 0),
      this.prisma.item.findMany({
        where: {
          ...baseWhere,
          metadata: {
            path: ['isRetracted'],
            equals: true,
          },
        },
        select: { metadata: true },
      }),
    ]);

    let retracted = 0;
    let expressionsOfConcern = 0;
    let manual = 0;

    for (const item of retractedItems) {
      const meta = (item.metadata as any) ?? {};
      if (meta.isRetracted) {
        retracted++;
        if (meta.retractionNature === 'expression_of_concern')
          expressionsOfConcern++;
        if (meta.retractionNature === 'manual') manual++;
      }
    }

    return {
      totalItems: typeof totalItems === 'number' ? totalItems : retractedItems.length,
      checkedItems: totalItems,
      retractedCount: retracted,
      expressionsOfConcernCount: expressionsOfConcern,
      manualCount: manual,
    };
  }

  async findGlobalStaleItemsForSync(staleBefore: Date, limit = 100) {
    const items = await this.prisma.item.findMany({
      where: {
        deletedAt: null,
        NOT: {
          AND: [{ doi: null }, { title: '' }],
        },
      },
      select: {
        id: true,
        userId: true,
        projectId: true,
        title: true,
        doi: true,
        metadata: true,
      },
      take: limit * 2,
    });

    return items
      .map((item) => {
        const meta = (item.metadata as any) ?? {};
        return {
          id: item.id,
          userId: item.userId,
          projectId: item.projectId,
          title: item.title,
          doi: item.doi,
          pmid: meta.pmid ?? null,
          isRetracted: Boolean(meta.isRetracted),
          retractionNature: meta.retractionNature ?? null,
          retractionCheckedAt: meta.retractionCheckedAt
            ? new Date(meta.retractionCheckedAt)
            : null,
        };
      })
      .filter(
        (i) => !i.retractionCheckedAt || i.retractionCheckedAt < staleBefore,
      )
      .slice(0, limit);
  }

  // ── Retraction Database Seed / Cache Operations ──────────────────────────
  async countRetractionRecords(): Promise<number> {
    return this.prisma.retraction.count();
  }

  async countRetractions(): Promise<number> {
    return this.prisma.retraction.count();
  }

  async upsertRetractionRecord(args: any) {
    return this.prisma.retraction.upsert(args);
  }

  async upsertRetraction(args: any) {
    return this.prisma.retraction.upsert(args);
  }

  async findRetractionRecordsForMemoryIndex() {
    return this.prisma.retraction.findMany({
      where: { isRetracted: true },
      select: {
        doi: true,
        pmid: true,
        title: true,
        nature: true,
        noticeType: true,
        reason: true,
        noticeUrl: true,
        journal: true,
        retractionDate: true,
        source: true,
      },
    });
  }

  async findRetractionRecord(where: any) {
    return this.prisma.retraction.findFirst({
      where: where?.where ?? where,
    });
  }

  async findRetraction(where: any) {
    return this.prisma.retraction.findFirst({
      where: where?.where ?? where,
    });
  }

  async getDatabaseStats(): Promise<{
    totalRecords: number;
    retractedCount: number;
    cleanCount: number;
    sourceBreakdown: Record<string, number>;
    lastCheckedAt?: Date;
  }> {
    const [totalRecords, retractedCount, cleanCount, sources] =
      await Promise.all([
        this.prisma.retraction.count(),
        this.prisma.retraction.count({ where: { isRetracted: true } }),
        this.prisma.retraction.count({ where: { isRetracted: false } }),
        this.prisma.retraction.groupBy({
          by: ['source'],
          _count: true,
        }),
      ]);

    const sourceBreakdown: Record<string, number> = {};
    for (const s of sources) {
      sourceBreakdown[s.source] = s._count;
    }

    const latest = await this.prisma.retraction.findFirst({
      orderBy: { checkedAt: 'desc' },
      select: { checkedAt: true },
    });

    return {
      totalRecords,
      retractedCount,
      cleanCount,
      sourceBreakdown,
      lastCheckedAt: latest?.checkedAt ?? undefined,
    };
  }
}
