import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { Prisma, WorkspaceMemberRole, Workspace } from '@prisma/client';
import {
  IWorkspaceRepository,
  WorkspaceWithMembers,
} from './types/workspace-repository.interface';

const USER_SELECT = {
  id: true,
  name: true,
  email: true,
  avatar: true,
} as const;

@Injectable()
export class WorkspaceRepository implements IWorkspaceRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findUserWorkspaces(userId: string): Promise<WorkspaceWithMembers[]> {
    const members = await this.prisma.workspaceMember.findMany({
      where: {
        userId,
        workspace: {
          deletedAt: null,
        },
      },
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

  async findById(id: string): Promise<WorkspaceWithMembers | null> {
    return this.prisma.workspace.findFirst({
      where: {
        id,
        deletedAt: null,
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

  async findBySlug(slug: string): Promise<WorkspaceWithMembers | null> {
    return this.prisma.workspace.findFirst({
      where: {
        OR: [{ slug }, { url: slug }],
        deletedAt: null,
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

  async findByIdOrSlug(idOrSlug: string): Promise<WorkspaceWithMembers | null> {
    return this.prisma.workspace.findFirst({
      where: {
        OR: [{ id: idOrSlug }, { slug: idOrSlug }, { url: idOrSlug }],
        deletedAt: null,
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

  async findWorkspaceByIdOrUrl(
    workspaceIdOrUrl: string,
  ): Promise<WorkspaceWithMembers | null> {
    return this.findByIdOrSlug(workspaceIdOrUrl);
  }

  async findWorkspaceByUrl(url: string) {
    return this.prisma.workspace.findFirst({
      where: {
        OR: [{ url }, { slug: url }],
        deletedAt: null,
      },
    });
  }

  async findWorkspaceByInviteCode(inviteCode: string) {
    return this.findByInviteCode(inviteCode);
  }

  async findByInviteCode(inviteCode: string): Promise<Workspace | null> {
    return this.prisma.workspace.findFirst({
      where: {
        inviteCode,
        deletedAt: null,
      },
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

  async softDeleteWorkspace(id: string): Promise<Workspace> {
    return this.prisma.workspace.update({
      where: { id },
      data: {
        deletedAt: new Date(),
      },
    });
  }

  async restoreWorkspace(id: string): Promise<Workspace> {
    return this.prisma.workspace.update({
      where: { id },
      data: {
        deletedAt: null,
      },
    });
  }

  async deleteWorkspace(id: string) {
    return this.softDeleteWorkspace(id);
  }

  async findMembers(workspaceId: string) {
    return this.prisma.workspaceMember.findMany({
      where: { workspaceId },
      include: {
        user: { select: USER_SELECT },
      },
      orderBy: { joinedAt: 'asc' },
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
      where: { workspaceId, role: WorkspaceMemberRole.owner },
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

  async deleteMember(workspaceId: string, userId: string): Promise<void> {
    await this.prisma.workspaceMember.delete({
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
      select: { id: true, email: true },
    });
  }

  async searchProjects(workspaceId: string, query: string) {
    return this.prisma.project.findMany({
      where: {
        workspaceId,
        name: { contains: query, mode: 'insensitive' },
        isActive: true,
        deletedAt: null,
      },
      select: { id: true, name: true, avatar: true, updatedAt: true },
      take: 10,
    });
  }

  async searchTasks(workspaceId: string, query: string) {
    return this.prisma.task.findMany({
      where: {
        project: { workspaceId, deletedAt: null },
        deletedAt: null,
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
    return this.prisma.catalogItem.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        OR: [
          { title: { contains: query, mode: 'insensitive' } },
          { abstract: { contains: query, mode: 'insensitive' } },
          {
            contributors: {
              some: { fullName: { contains: query, mode: 'insensitive' } },
            },
          },
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

  async withTransaction<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(fn);
  }
}
