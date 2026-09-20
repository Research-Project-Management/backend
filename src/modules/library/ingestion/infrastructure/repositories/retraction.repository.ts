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
        identifiers: true,
      },
    });
  }

  async findItemsForScan(
    userId: string,
    itemIds?: string[],
    projectId?: string,
  ) {
    const scopeWhere = this.getScopeWhere(userId, projectId);
    return this.prisma.item.findMany({
      where: {
        ...scopeWhere,
        ...(itemIds && itemIds.length > 0 ? { id: { in: itemIds } } : {}),
      },
      select: {
        id: true,
        title: true,
        doi: true,
        pmid: true,
        isRetracted: true,
        retractionNature: true,
        retractionCheckedAt: true,
      },
    });
  }

  async findStaleItemsForSync(
    userId: string,
    staleBefore: Date,
    projectId?: string,
    limit = 100,
  ) {
    const scopeWhere = this.getScopeWhere(userId, projectId);
    return this.prisma.item.findMany({
      where: {
        ...scopeWhere,
        OR: [
          { retractionCheckedAt: null },
          { retractionCheckedAt: { lt: staleBefore } },
        ],
        NOT: {
          AND: [{ doi: null }, { pmid: null }, { title: '' }],
        },
      },
      select: {
        id: true,
        title: true,
        doi: true,
        pmid: true,
        isRetracted: true,
        retractionNature: true,
        retractionCheckedAt: true,
      },
      take: limit,
    });
  }

  async updateItemRetraction(
    itemId: string,
    isRetracted: boolean,
    nature?: RetractionNature | null,
    details?: RetractionDetails | null,
    checkedAt: Date = new Date(),
  ) {
    if (!isValidId(itemId)) return null as any;
    return this.prisma.item.update({
      where: { id: itemId },
      data: {
        isRetracted,
        retractionNature: nature || null,
        retractionDetails: (details as any) || null,
        retractionCheckedAt: checkedAt,
      },
    });
  }

  async findRetractedItems(userId: string, projectId?: string) {
    const scopeWhere = this.getScopeWhere(userId, projectId);
    return this.prisma.item.findMany({
      where: {
        ...scopeWhere,
        isRetracted: true,
      },
      orderBy: [{ updatedAt: 'desc' }],
      include: {
        contributors: { orderBy: { orderIndex: 'asc' } },
        identifiers: true,
        attachments: { take: 2 },
        itemTags: { include: { tag: true } },
      },
    });
  }

  async getStats(userId: string, projectId?: string): Promise<RetractionStats> {
    const baseWhere = this.getScopeWhere(userId, projectId);

    const [total, checked, retracted, expressionsOfConcern, manual] =
      await Promise.all([
        this.prisma.item.count({
          where: baseWhere,
        }),
        this.prisma.item.count({
          where: {
            ...baseWhere,
            retractionCheckedAt: { not: null },
          },
        }),
        this.prisma.item.count({
          where: {
            ...baseWhere,
            isRetracted: true,
          },
        }),
        this.prisma.item.count({
          where: {
            ...baseWhere,
            isRetracted: true,
            retractionNature: 'expression_of_concern',
          },
        }),
        this.prisma.item.count({
          where: {
            ...baseWhere,
            isRetracted: true,
            retractionNature: 'manual',
          },
        }),
      ]);

    return {
      totalItems: total,
      checkedItems: checked,
      retractedCount: retracted,
      expressionsOfConcernCount: expressionsOfConcern,
      manualCount: manual,
    };
  }

  // ── Retraction Database Seed / Cache Operations ──────────────────────────
  async countRetractionRecords(): Promise<number> {
    return this.prisma.retractionRecord.count();
  }

  async upsertRetractionRecord(args: any) {
    return this.prisma.retractionRecord.upsert(args);
  }

  async findRetractionRecordsForMemoryIndex() {
    return this.prisma.retractionRecord.findMany({
      where: { isRetracted: true },
      select: {
        doi: true,
        pmid: true,
        nature: true,
        reason: true,
        noticeUrl: true,
        retractionDate: true,
        source: true,
      },
    });
  }

  async findRetractionRecord(where: any) {
    return this.prisma.retractionRecord.findFirst({
      where,
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
        this.prisma.retractionRecord.count(),
        this.prisma.retractionRecord.count({ where: { isRetracted: true } }),
        this.prisma.retractionRecord.count({ where: { isRetracted: false } }),
        this.prisma.retractionRecord.groupBy({
          by: ['source'],
          _count: true,
        }),
      ]);

    const sourceBreakdown: Record<string, number> = {};
    for (const s of sources) {
      sourceBreakdown[s.source] = s._count;
    }

    const latest = await this.prisma.retractionRecord.findFirst({
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
