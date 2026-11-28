/**
 * modules/pages/page/page.repository.ts
 * Prisma persistence repository for Page aggregate metadata, thumbnails, and labels.
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core';

export type ResolvedSpaceLabel = {
  id: string;
  name: string;
  color: string;
};

@Injectable()
export class PageRepository {
  constructor(private readonly prisma: PrismaService) {}

  public async findActivePageInSpace(
    spaceId: string,
    pageId: string,
  ): Promise<{ id: string; spaceId: string; rootDocId: string | null } | null> {
    if (!this.prisma.page?.findFirst) {
      return null;
    }
    return await Promise.resolve(
      this.prisma.page.findFirst({
        where: {
          id: pageId,
          spaceId,
          deletedAt: null,
        },
        select: {
          id: true,
          spaceId: true,
          rootDocId: true,
        },
      }),
    ).catch(() => null);
  }

  public async findSpaceLabelsByIds(
    spaceId: string,
    labelIds: string[],
  ): Promise<ResolvedSpaceLabel[]> {
    if (!labelIds.length || !this.prisma.spaceLabel?.findMany) {
      return [];
    }
    const found = await this.prisma.spaceLabel.findMany({
      where: {
        id: { in: labelIds },
        OR: [
          { spaceId },
          { projectAssignments: { some: { projectId: spaceId } } },
        ],
      },
    });
    return found.map((l) => ({
      id: l.id,
      name: l.name,
      color: l.color,
    }));
  }

  public async findPageLabels(pageId: string): Promise<ResolvedSpaceLabel[]> {
    if (!this.prisma.pageLabel?.findMany) {
      return [];
    }
    const rows = await this.prisma.pageLabel.findMany({
      where: { pageId },
      include: { label: { select: { id: true, name: true, color: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      id: r.label.id,
      name: r.label.name,
      color: r.label.color,
    }));
  }

  public async replacePageLabels(
    pageId: string,
    labelIds: string[],
  ): Promise<void> {
    if (!this.prisma.pageLabel?.deleteMany) {
      return;
    }
    const uniqueIds = Array.from(new Set(labelIds));
    await this.prisma.$transaction(async (tx) => {
      await tx.pageLabel.deleteMany({ where: { pageId } });
      if (uniqueIds.length > 0) {
        await tx.pageLabel.createMany({
          data: uniqueIds.map((labelId) => ({ pageId, labelId })),
          skipDuplicates: true,
        });
      }
    });
  }

  public async removePageLabel(pageId: string, labelId: string): Promise<void> {
    if (!this.prisma.pageLabel?.deleteMany) {
      return;
    }
    await this.prisma.pageLabel.deleteMany({
      where: { pageId, labelId },
    });
  }

  public async updatePageThumbnail(
    pageId: string,
    thumbnail: string,
    spaceId?: string,
  ): Promise<void> {
    if (!this.prisma.page?.updateMany) {
      return;
    }
    await this.prisma.page.updateMany({
      where: {
        id: pageId,
        ...(spaceId ? { spaceId } : {}),
        deletedAt: null,
      },
      data: { thumbnail },
    });
  }
}
