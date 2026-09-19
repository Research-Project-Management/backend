import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { Prisma, PageVersion } from '@prisma/client';
import { IHistoryRepository } from '../core/types/document-repository.interface';

@Injectable()
export class HistoryRepository implements IHistoryRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Summary list — excludes heavy `content` field for version history list view */
  async findPageVersions(pageId: string) {
    const versions = await this.prisma.pageVersion.findMany({
      where: {
        OR: [
          { pageId },
          { projectPageId: pageId },
          { page: { projectId: pageId } },
        ],
      },
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
    });

    if (versions.length === 0) return [];

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
        select: { id: true, name: true, avatar: true },
      });
      userMap = new Map(users.map((u) => [u.id, u]));
    }

    return versions.map((v) => ({
      ...v,
      savedBy: v.savedById
        ? userMap.get(v.savedById) || { id: v.savedById, name: 'User' }
        : { id: 'sys', name: 'System' },
    }));
  }

  async findVersionById(versionId: string): Promise<
    | (PageVersion & {
        savedBy?: { id: string; name: string; avatar?: string | null };
      })
    | null
  > {
    const version = await this.prisma.pageVersion.findUnique({
      where: { id: versionId },
    });
    if (!version) return null;

    let savedBy: { id: string; name: string; avatar?: string | null } = {
      id: 'sys',
      name: 'System',
    };
    if (version.savedById) {
      const user = await this.prisma.user.findUnique({
        where: { id: version.savedById },
        select: { id: true, name: true, avatar: true },
      });
      if (user) savedBy = user;
      else savedBy = { id: version.savedById, name: 'User' };
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

  async deleteVersion(versionId: string): Promise<PageVersion> {
    return this.prisma.pageVersion.delete({
      where: { id: versionId },
    });
  }
}
