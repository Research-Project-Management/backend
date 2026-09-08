import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import {
  buildWorkspaceIdentifierWhere,
  isUuid,
} from '@/core/utils/tenant.util';
import { Prisma, StickyScope, Sticky } from '@prisma/client';
import {
  IStickyRepository,
  StickyWithUser,
  USER_MINIMAL_SELECT,
} from './types/sticky-repository.interface';

export type { StickyWithUser };

@Injectable()
export class StickyRepository implements IStickyRepository {
  constructor(private readonly prisma: PrismaService) {}

  async resolveWorkspace(
    workspaceIdOrSlug: string,
  ): Promise<{ id: string } | null> {
    return this.prisma.workspace.findFirst({
      where: buildWorkspaceIdentifierWhere(workspaceIdOrSlug),
      select: { id: true },
    });
  }

  async findStickyById(stickyId: string): Promise<StickyWithUser | null> {
    if (!isUuid(stickyId)) return null;
    return this.prisma.sticky.findUnique({
      where: { id: stickyId },
      include: {
        user: { select: USER_MINIMAL_SELECT },
      },
    });
  }

  async findWorkspaceStickies(
    workspaceId: string,
    userId: string,
  ): Promise<StickyWithUser[]> {
    const ws = await this.resolveWorkspace(workspaceId);
    const canonicalWorkspaceId =
      ws?.id || (isUuid(workspaceId) ? workspaceId : null);
    if (!canonicalWorkspaceId || !isUuid(userId)) return [];

    return this.prisma.sticky.findMany({
      where: {
        workspaceId: canonicalWorkspaceId,
        userId,
        scope: StickyScope.workspace,
      },
      include: {
        user: { select: USER_MINIMAL_SELECT },
      },
      orderBy: { order: 'asc' },
    });
  }

  async findProjectStickies(
    projectId: string,
    userId: string,
  ): Promise<StickyWithUser[]> {
    if (!isUuid(projectId) || !isUuid(userId)) return [];
    return this.prisma.sticky.findMany({
      where: {
        projectId,
        userId,
        scope: StickyScope.project,
      },
      include: {
        user: { select: USER_MINIMAL_SELECT },
      },
      orderBy: { order: 'asc' },
    });
  }

  async countWorkspaceStickies(
    workspaceId: string,
    userId: string,
  ): Promise<number> {
    const ws = await this.resolveWorkspace(workspaceId);
    const canonicalWorkspaceId =
      ws?.id || (isUuid(workspaceId) ? workspaceId : null);
    if (!canonicalWorkspaceId || !isUuid(userId)) return 0;

    return this.prisma.sticky.count({
      where: {
        workspaceId: canonicalWorkspaceId,
        userId,
        scope: StickyScope.workspace,
      },
    });
  }

  async countProjectStickies(
    projectId: string,
    userId: string,
  ): Promise<number> {
    if (!isUuid(projectId) || !isUuid(userId)) return 0;
    return this.prisma.sticky.count({
      where: {
        projectId,
        userId,
        scope: StickyScope.project,
      },
    });
  }

  async createSticky(
    data: Prisma.StickyCreateInput | Prisma.StickyUncheckedCreateInput,
  ): Promise<StickyWithUser> {
    return this.prisma.sticky.create({
      data: data as Prisma.StickyCreateInput,
      include: {
        user: { select: USER_MINIMAL_SELECT },
      },
    });
  }

  async updateSticky(
    stickyId: string,
    data: Prisma.StickyUpdateInput | Prisma.StickyUncheckedUpdateInput,
  ): Promise<StickyWithUser> {
    return this.prisma.sticky.update({
      where: { id: stickyId },
      data: data,
      include: {
        user: { select: USER_MINIMAL_SELECT },
      },
    });
  }

  async deleteSticky(stickyId: string): Promise<Sticky> {
    return this.prisma.sticky.delete({
      where: { id: stickyId },
    });
  }

  async findStickiesByIds(stickyIds: string[]): Promise<Sticky[]> {
    const validIds = stickyIds.filter(isUuid);
    if (validIds.length === 0) return [];
    return this.prisma.sticky.findMany({
      where: { id: { in: validIds } },
    });
  }

  async reorderStickies(stickyIds: string[]): Promise<Sticky[]> {
    const validIds = stickyIds.filter(isUuid);
    if (validIds.length === 0) return [];
    const updates = validIds.map((id, index) =>
      this.prisma.sticky.update({
        where: { id },
        data: { order: index },
      }),
    );
    return this.prisma.$transaction(updates);
  }

  async findProjectWorkspaceId(projectId: string): Promise<string | null> {
    if (!isUuid(projectId)) {
      const project = await this.prisma.project
        .findFirst({
          where: {
            identifier: { equals: projectId, mode: 'insensitive' },
            deletedAt: null,
          },
          select: { workspaceId: true },
        })
        .catch(() => null);
      return project?.workspaceId || null;
    }
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { workspaceId: true },
    });
    return project?.workspaceId || null;
  }
}
