import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
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
      where: {
        OR: [
          { id: workspaceIdOrSlug },
          { slug: workspaceIdOrSlug },
          { url: workspaceIdOrSlug },
        ],
        deletedAt: null,
      },
      select: { id: true },
    });
  }

  async findStickyById(stickyId: string): Promise<StickyWithUser | null> {
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
    const targetId = ws?.id || workspaceId;
    return this.prisma.sticky.findMany({
      where: {
        workspaceId: targetId,
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
    const targetId = ws?.id || workspaceId;
    return this.prisma.sticky.count({
      where: {
        workspaceId: targetId,
        userId,
        scope: StickyScope.workspace,
      },
    });
  }

  async countProjectStickies(
    projectId: string,
    userId: string,
  ): Promise<number> {
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

  async reorderStickies(stickyIds: string[]): Promise<Sticky[]> {
    const updates = stickyIds.map((id, index) =>
      this.prisma.sticky.update({
        where: { id },
        data: { order: index },
      }),
    );
    return this.prisma.$transaction(updates);
  }

  async findProjectWorkspaceId(projectId: string): Promise<string | null> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { workspaceId: true },
    });
    return project?.workspaceId || null;
  }
}
