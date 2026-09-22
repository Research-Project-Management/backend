import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { Prisma, PageVersion } from '@prisma/client';
import {
  IHistoryRepository,
  PaginatedPageVersions,
  VersionQueryOptions,
} from '../page/types/page-repository.interface';

@Injectable()
export class HistoryRepository implements IHistoryRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Summary list — excludes heavy `content` field for version history list view */
  async findPageVersions(
    pageId: string,
    options?: VersionQueryOptions,
  ): Promise<PaginatedPageVersions> {
    const limit = Math.min(Math.max(options?.limit ?? 50, 1), 200);
    const cursor = options?.cursor;
    const eventType = options?.eventType;

    const baseWhere: Prisma.PageVersionWhereInput = {
      OR: [
        { pageId },
        { projectPageId: pageId },
        { page: { projectId: pageId } },
      ],
      ...(eventType ? { eventType } : {}),
      ...(options?.labeledOnly ? { label: { not: null, notIn: [''] } } : {}),
    };

    const [total, rawVersions] = await Promise.all([
      this.prisma.pageVersion.count({ where: baseWhere }),
      this.prisma.pageVersion.findMany({
        where: baseWhere,
        select: {
          id: true,
          pageId: true,
          title: true,
          label: true,
          eventType: true,
          savedById: true,
          fileName: true,
          projectPageId: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: limit + 1,
        ...(cursor
          ? {
              cursor: { id: cursor },
              skip: 1,
            }
          : {}),
      }),
    ]);

    let nextCursor: string | null = null;
    let versions = rawVersions;
    if (rawVersions.length > limit) {
      const nextItem = rawVersions[limit];
      nextCursor = nextItem.id;
      versions = rawVersions.slice(0, limit);
    }

    if (versions.length === 0) {
      return { versions: [], total, nextCursor: null };
    }

    const userIds = [
      ...new Set(versions.map((v) => v.savedById).filter(Boolean)),
    ] as string[];

    let userMap = new Map<
      string,
      { id: string; name: string; avatar?: string | null }
    >();
    if (userIds.length > 0) {
      const users = await this.prisma.user.findMany({
        where: { id: { in: userIds } },
        select: {
          id: true,
          profile: {
            select: {
              name: true,
              avatar: true,
            },
          },
        },
      });
      userMap = new Map(
        users.map((u) => [
          u.id,
          {
            id: u.id,
            name: u.profile?.name ?? 'User',
            avatar: u.profile?.avatar ?? null,
          },
        ]),
      );
    }

    const enrichedVersions = versions.map((v) => ({
      ...v,
      savedBy: v.savedById
        ? userMap.get(v.savedById) || { id: v.savedById, name: 'User' }
        : { id: 'sys', name: 'System' },
    }));

    return {
      versions: enrichedVersions,
      total,
      nextCursor,
    };
  }

  async findVersionById(versionId: string): Promise<
    | (PageVersion & {
        savedBy?: { id: string; name: string; avatar?: string | null };
        page?: { id: string; projectId: string | null } | null;
      })
    | null
  > {
    const version = await this.prisma.pageVersion.findUnique({
      where: { id: versionId },
      include: {
        page: {
          select: {
            id: true,
            projectId: true,
          },
        },
      },
    });
    if (!version) return null;

    let savedBy: { id: string; name: string; avatar?: string | null } = {
      id: 'sys',
      name: 'System',
    };
    if (version.savedById) {
      const user = await this.prisma.user.findUnique({
        where: { id: version.savedById },
        select: {
          id: true,
          profile: {
            select: {
              name: true,
              avatar: true,
            },
          },
        },
      });
      if (user) {
        savedBy = {
          id: user.id,
          name: user.profile?.name ?? 'User',
          avatar: user.profile?.avatar ?? null,
        };
      } else {
        savedBy = { id: version.savedById, name: 'User' };
      }
    }

    return {
      ...version,
      savedBy,
    };
  }

  async createVersion(
    data:
      Prisma.PageVersionCreateInput | Prisma.PageVersionUncheckedCreateInput,
  ): Promise<PageVersion> {
    return this.prisma.pageVersion.create({
      data: data as Prisma.PageVersionCreateInput,
    });
  }

  async updateVersion(
    versionId: string,
    data:
      Prisma.PageVersionUpdateInput | Prisma.PageVersionUncheckedUpdateInput,
  ): Promise<PageVersion> {
    return this.prisma.pageVersion.update({
      where: { id: versionId },
      data: data,
    });
  }

  async deleteVersion(versionId: string): Promise<PageVersion> {
    return this.prisma.pageVersion.delete({
      where: { id: versionId },
    });
  }
}
