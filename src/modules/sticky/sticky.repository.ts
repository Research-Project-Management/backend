import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { Prisma, StickyScope } from '@prisma/client';

const USER_SELECT = {
  id: true,
  name: true,
  email: true,
  avatar: true,
} as const;

export type StickyWithUser = Prisma.StickyGetPayload<{
  include: {
    user: { select: typeof USER_SELECT };
  };
}>;

@Injectable()
export class StickyRepository {
  constructor(private readonly prisma: PrismaService) {}

  async resolveWorkspace(workspaceIdOrSlug: string) {
    return this.prisma.workspace.findFirst({
      where: { OR: [{ id: workspaceIdOrSlug }, { url: workspaceIdOrSlug }] },
      select: { id: true },
    });
  }

  async findWorkspaceStickies(workspaceId: string): Promise<StickyWithUser[]> {
    const ws = await this.resolveWorkspace(workspaceId);
    const targetId = ws?.id || workspaceId;
    return this.prisma.sticky.findMany({
      where: {
        workspaceId: targetId,
        scope: StickyScope.workspace,
      },
      include: {
        user: { select: USER_SELECT },
      },
      orderBy: { order: 'asc' },
    });
  }

  async findProjectStickies(projectId: string): Promise<StickyWithUser[]> {
    return this.prisma.sticky.findMany({
      where: {
        projectId,
        scope: StickyScope.project,
      },
      include: {
        user: { select: USER_SELECT },
      },
      orderBy: { order: 'asc' },
    });
  }

  async countWorkspaceStickies(workspaceId: string): Promise<number> {
    const ws = await this.resolveWorkspace(workspaceId);
    const targetId = ws?.id || workspaceId;
    return this.prisma.sticky.count({
      where: { workspaceId: targetId, scope: StickyScope.workspace },
    });
  }

  async countProjectStickies(projectId: string): Promise<number> {
    return this.prisma.sticky.count({
      where: { projectId, scope: StickyScope.project },
    });
  }

  async createSticky(
    data: Prisma.StickyCreateInput | Prisma.StickyUncheckedCreateInput,
  ): Promise<StickyWithUser> {
    return this.prisma.sticky.create({
      data: data as Prisma.StickyCreateInput,
      include: {
        user: { select: USER_SELECT },
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
        user: { select: USER_SELECT },
      },
    });
  }

  async deleteSticky(stickyId: string) {
    return this.prisma.sticky.delete({
      where: { id: stickyId },
    });
  }

  async reorderStickies(stickyIds: string[]) {
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
