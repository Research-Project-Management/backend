import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { Prisma, WorkspaceMemberRole } from '@prisma/client';

const USER_SELECT = {
  id: true,
  name: true,
  email: true,
  avatar: true,
} as const;

export type WorkspaceWithMembers = Prisma.WorkspaceGetPayload<{
  include: {
    members: {
      include: {
        user: {
          select: typeof USER_SELECT;
        };
      };
    };
  };
}>;

@Injectable()
export class WorkspaceRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findUserWorkspaces(userId: string) {
    const members = await this.prisma.workspaceMember.findMany({
      where: { userId },
      include: {
        workspace: {
          include: {
            members: {
              include: {
                user: { select: USER_SELECT },
              },
            },
          },
        },
      },
    });

    return members.map((m) => m.workspace);
  }

  async findWorkspaceByIdOrUrl(
    workspaceIdOrUrl: string,
  ): Promise<WorkspaceWithMembers | null> {
    return this.prisma.workspace.findFirst({
      where: {
        OR: [{ id: workspaceIdOrUrl }, { url: workspaceIdOrUrl }],
      },
      include: {
        members: {
          include: {
            user: { select: USER_SELECT },
          },
        },
      },
    });
  }

  async findWorkspaceByUrl(url: string) {
    return this.prisma.workspace.findUnique({
      where: { url },
    });
  }

  async findWorkspaceByInviteCode(inviteCode: string) {
    return this.prisma.workspace.findUnique({
      where: { inviteCode },
    });
  }

  async createWorkspace(
    data: Prisma.WorkspaceCreateInput | Prisma.WorkspaceUncheckedCreateInput,
  ): Promise<WorkspaceWithMembers> {
    return this.prisma.workspace.create({
      data: data,
      include: {
        members: {
          include: {
            user: { select: USER_SELECT },
          },
        },
      },
    });
  }

  async updateWorkspace(
    id: string,
    data: Prisma.WorkspaceUpdateInput | Prisma.WorkspaceUncheckedUpdateInput,
  ): Promise<WorkspaceWithMembers> {
    return this.prisma.workspace.update({
      where: { id },
      data: data,
      include: {
        members: {
          include: {
            user: { select: USER_SELECT },
          },
        },
      },
    });
  }

  async deleteWorkspace(id: string) {
    return this.prisma.workspace.delete({
      where: { id },
    });
  }

  async findMembers(workspaceId: string) {
    return this.prisma.workspaceMember.findMany({
      where: { workspaceId },
      include: {
        user: { select: USER_SELECT },
      },
    });
  }

  async findMember(workspaceId: string, userId: string) {
    return this.prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId,
          userId,
        },
      },
      include: {
        user: { select: USER_SELECT },
      },
    });
  }

  async countOwners(workspaceId: string): Promise<number> {
    return this.prisma.workspaceMember.count({
      where: { workspaceId, role: 'owner' },
    });
  }

  async createMember(
    workspaceId: string,
    userId: string,
    role: WorkspaceMemberRole = WorkspaceMemberRole.member,
  ) {
    return this.prisma.workspaceMember.create({
      data: {
        workspaceId,
        userId,
        role,
      },
      include: {
        user: { select: USER_SELECT },
      },
    });
  }

  async updateMemberRole(
    workspaceId: string,
    userId: string,
    role: WorkspaceMemberRole,
  ) {
    return this.prisma.workspaceMember.update({
      where: {
        workspaceId_userId: {
          workspaceId,
          userId,
        },
      },
      data: { role },
      include: {
        user: { select: USER_SELECT },
      },
    });
  }

  async deleteMember(workspaceId: string, userId: string) {
    return this.prisma.workspaceMember.delete({
      where: {
        workspaceId_userId: {
          workspaceId,
          userId,
        },
      },
    });
  }

  async findUserByEmail(email: string) {
    return this.prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });
  }

  async searchProjects(workspaceId: string, query: string) {
    return this.prisma.project.findMany({
      where: {
        workspaceId,
        name: { contains: query, mode: 'insensitive' },
        isActive: true,
      },
      select: { id: true, name: true, avatar: true, updatedAt: true },
      take: 10,
    });
  }

  async searchTasks(workspaceId: string, query: string) {
    return this.prisma.task.findMany({
      where: {
        project: { workspaceId },
        OR: [
          { title: { contains: query, mode: 'insensitive' } },
          { identifier: { contains: query, mode: 'insensitive' } },
        ],
      },
      select: {
        id: true,
        title: true,
        identifier: true,
        projectId: true,
        project: { select: { name: true } },
        updatedAt: true,
      },
      take: 10,
    });
  }

  async searchPapers(workspaceId: string, query: string) {
    return this.prisma.paper.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        OR: [
          { title: { contains: query, mode: 'insensitive' } },
          { abstract: { contains: query, mode: 'insensitive' } },
          { authors: { has: query } },
        ],
      },
      select: {
        id: true,
        title: true,
        updatedAt: true,
      },
      take: 10,
    });
  }

  async searchPages(workspaceId: string, query: string) {
    return this.prisma.page.findMany({
      where: {
        OR: [
          { workspaceId, title: { contains: query, mode: 'insensitive' } },
          {
            project: { workspaceId },
            title: { contains: query, mode: 'insensitive' },
          },
        ],
        deletedAt: null,
      },
      select: {
        id: true,
        title: true,
        projectId: true,
        project: { select: { name: true } },
        updatedAt: true,
      },
      take: 10,
    });
  }

  async searchFiles(workspaceId: string, query: string) {
    return this.prisma.file.findMany({
      where: {
        workspaceId,
        filename: { contains: query, mode: 'insensitive' },
        trashedAt: null,
      },
      select: {
        id: true,
        filename: true,
        mimeType: true,
        size: true,
        isFolder: true,
        updatedAt: true,
      },
      take: 10,
    });
  }

  async searchStickies(workspaceId: string, query: string) {
    return this.prisma.sticky.findMany({
      where: {
        workspaceId,
        OR: [
          { title: { contains: query, mode: 'insensitive' } },
          { content: { contains: query, mode: 'insensitive' } },
        ],
      },
      select: {
        id: true,
        title: true,
        content: true,
        color: true,
        updatedAt: true,
      },
      take: 10,
    });
  }
}
