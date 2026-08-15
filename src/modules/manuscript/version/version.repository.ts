import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { Prisma } from '@prisma/client';

@Injectable()
export class VersionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findPageVersions(pageId: string) {
    return this.prisma.pageVersion.findMany({
      where: { pageId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findVersionById(versionId: string) {
    return this.prisma.pageVersion.findUnique({
      where: { id: versionId },
    });
  }

  async createVersion(
    data:
      Prisma.PageVersionCreateInput | Prisma.PageVersionUncheckedCreateInput,
  ) {
    return this.prisma.pageVersion.create({
      data: data as Prisma.PageVersionCreateInput,
    });
  }

  async deleteVersion(versionId: string) {
    return this.prisma.pageVersion.delete({
      where: { id: versionId },
    });
  }

  async findPageById(pageId: string) {
    return this.prisma.page.findUnique({
      where: { id: pageId },
    });
  }

  async updatePage(
    pageId: string,
    data: Prisma.PageUpdateInput | Prisma.PageUncheckedUpdateInput,
  ) {
    return this.prisma.page.update({
      where: { id: pageId },
      data: data,
    });
  }
}
