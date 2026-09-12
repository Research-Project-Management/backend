import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../core/database/prisma.service';
import {
  RetractionDetails,
  RetractionNature,
  RetractionStats,
} from './types/retraction.types';

@Injectable()
export class RetractionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findItemById(userId: string, itemId: string) {
    return this.prisma.item.findFirst({
      where: {
        id: itemId,
        userId,
        deletedAt: null,
      },
      include: {
        contributors: { orderBy: { orderIndex: 'asc' } },
        identifiers: true,
      },
    });
  }

  async findItemsForScan(userId: string, itemIds?: string[]) {
    return this.prisma.item.findMany({
      where: {
        userId,
        deletedAt: null,
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

  async updateItemRetraction(
    itemId: string,
    isRetracted: boolean,
    nature?: RetractionNature | null,
    details?: RetractionDetails | null,
    checkedAt: Date = new Date(),
  ) {
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

  async findRetractedItems(userId: string) {
    return this.prisma.item.findMany({
      where: {
        userId,
        deletedAt: null,
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

  async getStats(
    userId: string,
  ): Promise<RetractionStats> {
    const baseWhere = {
      userId,
      deletedAt: null,
    };

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
}

