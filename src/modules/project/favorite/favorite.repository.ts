import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { ProjectFavorite } from '@prisma/client';

@Injectable()
export class FavoriteRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findUserFavorites(userId: string): Promise<string[]> {
    const rows = await this.prisma.projectFavorite.findMany({
      where: { userId },
      select: { projectId: true },
    });
    return rows.map((r) => r.projectId);
  }

  async isFavorite(projectId: string, userId: string): Promise<boolean> {
    const fav = await this.prisma.projectFavorite.findUnique({
      where: {
        projectId_userId: {
          projectId,
          userId,
        },
      },
    });
    return !!fav;
  }

  async addFavorite(
    projectId: string,
    userId: string,
  ): Promise<ProjectFavorite> {
    return this.prisma.projectFavorite.upsert({
      where: {
        projectId_userId: {
          projectId,
          userId,
        },
      },
      create: {
        projectId,
        userId,
      },
      update: {},
    });
  }

  async removeFavorite(projectId: string, userId: string): Promise<void> {
    await this.prisma.projectFavorite.deleteMany({
      where: {
        projectId,
        userId,
      },
    });
  }

  async batchCheckFavorites(
    projectIds: string[],
    userId: string,
  ): Promise<Set<string>> {
    if (!projectIds.length) return new Set();
    const rows = await this.prisma.projectFavorite.findMany({
      where: {
        userId,
        projectId: { in: projectIds },
      },
      select: { projectId: true },
    });
    return new Set(rows.map((r) => r.projectId));
  }
}
