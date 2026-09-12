import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import {
  buildWorkspaceIdentifierWhere,
  isUuid,
} from '@/core/utils/tenant.util';
import { Prisma, Workspace } from '@prisma/client';
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

  private async getCanonicalWorkspaceId(
    workspaceId: string,
  ): Promise<string | null> {
    if (!workspaceId) return null;
    if (isUuid(workspaceId)) return workspaceId;
    const ws = await this.prisma.workspace.findFirst({
      where: buildWorkspaceIdentifierWhere(workspaceId),
      select: { id: true },
    });
    return ws?.id ?? null;
  }

  /**
   * Personal workspace model: user's workspace is the one where ownerId === userId.
   * Returns array with at most 1 workspace.
   */
  async findUserWorkspaces(userId: string): Promise<WorkspaceWithMembers[]> {
    const workspace = await this.prisma.workspace.findFirst({
      where: {
        ownerId: userId,
        deletedAt: null,
      },
      include: {
        members: {
          take: 50,
          include: {
            user: { select: USER_SELECT },
          },
          orderBy: { joinedAt: 'asc' },
        },
        _count: {
          select: { members: true },
        },
      },
    });

    return workspace ? [workspace as unknown as WorkspaceWithMembers] : [];
  }

  async findById(id: string): Promise<WorkspaceWithMembers | null> {
    return this.prisma.workspace.findFirst({
      where: buildWorkspaceIdentifierWhere(id),
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
      where: buildWorkspaceIdentifierWhere(idOrSlug),
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
    return this.prisma.workspace.findFirst({
      where: {
        OR: [{ url }, { slug: url }],
        deletedAt: null,
      },
    });
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

  async findMembers(workspaceId: string) {
    const canonicalId = await this.getCanonicalWorkspaceId(workspaceId);
    if (!canonicalId) return [];
    return this.prisma.workspaceMember.findMany({
      where: { workspaceId: canonicalId },
      include: {
        user: { select: USER_SELECT },
      },
      orderBy: { joinedAt: 'asc' },
    });
  }

  async findMember(workspaceId: string, userId: string) {
    const canonicalId = await this.getCanonicalWorkspaceId(workspaceId);
    if (!canonicalId) return null;
    return this.prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId: canonicalId,
          userId,
        },
      },
      include: {
        user: { select: USER_SELECT },
      },
    });
  }

  async countOwners(workspaceId: string): Promise<number> {
    const canonicalId = await this.getCanonicalWorkspaceId(workspaceId);
    if (!canonicalId) return 0;
    return this.prisma.workspaceMember.count({
      where: { workspaceId: canonicalId, role: WorkspaceMemberRole.owner },
    });
  }

  async createMember(
    workspaceId: string,
    userId: string,
    role: WorkspaceMemberRole = WorkspaceMemberRole.member,
  ) {
    const canonicalId =
      (await this.getCanonicalWorkspaceId(workspaceId)) || workspaceId;
    return this.prisma.workspaceMember.create({
      data: {
        workspaceId: canonicalId,
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
    const canonicalId =
      (await this.getCanonicalWorkspaceId(workspaceId)) || workspaceId;
    return this.prisma.workspaceMember.update({
      where: {
        workspaceId_userId: {
          workspaceId: canonicalId,
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
    const canonicalId =
      (await this.getCanonicalWorkspaceId(workspaceId)) || workspaceId;
    await this.prisma.workspaceMember.delete({
      where: {
        workspaceId_userId: {
          workspaceId: canonicalId,
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
    const canonicalId = await this.getCanonicalWorkspaceId(workspaceId);
    if (!canonicalId) return [];
    return this.prisma.project.findMany({
      where: {
        workspaceId: canonicalId,
        name: { contains: query, mode: 'insensitive' },
        isActive: true,
        deletedAt: null,
      },
      select: { id: true, name: true, avatar: true, updatedAt: true },
      take: 10,
    });
  }

  async searchTasks(workspaceId: string, query: string) {
    const canonicalId = await this.getCanonicalWorkspaceId(workspaceId);
    if (!canonicalId) return [];
    return this.prisma.task.findMany({
      where: {
        project: { workspaceId: canonicalId, deletedAt: null },
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
    const canonicalId = await this.getCanonicalWorkspaceId(workspaceId);
    if (!canonicalId) return [];
    return this.prisma.item.findMany({
      where: {
        workspaceId: canonicalId,
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
    const canonicalId = await this.getCanonicalWorkspaceId(workspaceId);
    if (!canonicalId) return [];
    return this.prisma.page.findMany({
      where: {
        OR: [
          {
            workspaceId: canonicalId,
            title: { contains: query, mode: 'insensitive' },
          },
          {
            project: { workspaceId: canonicalId, deletedAt: null },
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
    const canonicalId = await this.getCanonicalWorkspaceId(workspaceId);
    if (!canonicalId) return [];
    return this.prisma.file.findMany({
      where: {
        workspaceId: canonicalId,
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
    const canonicalId = await this.getCanonicalWorkspaceId(workspaceId);
    if (!canonicalId) return [];
    return this.prisma.sticky.findMany({
      where: {
        workspaceId: canonicalId,
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
