import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { Prisma, PageVersion } from '@prisma/client';
import { IHistoryRepository } from '../types/document-repository.interface';

@Injectable()
export class HistoryRepository implements IHistoryRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Summary list — excludes heavy `content` field for version history list view */
  async findPageVersions(pageId: string) {
    return this.prisma.pageVersion.findMany({
      where: { pageId },
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
  }

  async findVersionById(versionId: string): Promise<PageVersion | null> {
    return this.prisma.pageVersion.findUnique({
      where: { id: versionId },
    });
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
