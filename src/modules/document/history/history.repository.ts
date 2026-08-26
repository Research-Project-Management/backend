import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { Prisma, PageVersion, Page } from '@prisma/client';
import { IHistoryRepository } from '../types/document-repository.interface';

@Injectable()
export class HistoryRepository implements IHistoryRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findPageVersions(pageId: string): Promise<PageVersion[]> {
    return this.prisma.pageVersion.findMany({
      where: { pageId },
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

  async findPageById(pageId: string): Promise<Page | null> {
    return this.prisma.page.findFirst({
      where: { id: pageId, deletedAt: null },
    });
  }

  async updatePage(
    pageId: string,
    data: Prisma.PageUpdateInput | Prisma.PageUncheckedUpdateInput,
  ): Promise<Page> {
    return this.prisma.page.update({
      where: { id: pageId },
      data: data,
    });
  }
}
