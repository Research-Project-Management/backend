import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { ProjectMemberRole, Prisma } from '@prisma/client';
import { IMemberRepository, ProjectMemberWithUser } from './types/member.types';
import { isUuid } from '@/core/utils/tenant.util';

const USER_SELECT = {
  id: true,
  name: true,
  email: true,
  avatar: true,
} as const;

@Injectable()
export class MemberRepository implements IMemberRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findMember(
    projectId: string,
    userId: string,
  ): Promise<ProjectMemberWithUser | null> {
    if (!isUuid(projectId) || !isUuid(userId)) return null;

    return this.prisma.projectMember.findUnique({
      where: {
        projectId_userId: {
          projectId,
          userId,
        },
      },
      include: {
        user: { select: USER_SELECT },
      },
    });
  }

  async findMembers(
    projectId: string,
    options?: {
      role?: ProjectMemberRole;
      search?: string;
      take?: number;
      skip?: number;
    },
  ): Promise<ProjectMemberWithUser[]> {
    if (!isUuid(projectId)) return [];

    const where: Prisma.ProjectMemberWhereInput = {
      projectId,
      ...(options?.role && { role: options.role }),
      ...(options?.search && {
        user: {
          OR: [
            { name: { contains: options.search, mode: 'insensitive' } },
            { email: { contains: options.search, mode: 'insensitive' } },
          ],
        },
      }),
    };

    return this.prisma.projectMember.findMany({
      where,
      include: {
        user: { select: USER_SELECT },
      },
      orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
      ...(options?.take ? { take: options.take } : {}),
      ...(options?.skip ? { skip: options.skip } : {}),
    });
  }

  async countMembers(
    projectId: string,
    options?: {
      role?: ProjectMemberRole;
      search?: string;
    },
  ): Promise<number> {
    if (!isUuid(projectId)) return 0;

    const where: Prisma.ProjectMemberWhereInput = {
      projectId,
      ...(options?.role && { role: options.role }),
      ...(options?.search && {
        user: {
          OR: [
            { name: { contains: options.search, mode: 'insensitive' } },
            { email: { contains: options.search, mode: 'insensitive' } },
          ],
        },
      }),
    };

    return this.prisma.projectMember.count({ where });
  }

  async createMember(
    projectId: string,
    userId: string,
    role: ProjectMemberRole,
  ): Promise<ProjectMemberWithUser> {
    return this.prisma.projectMember.create({
      data: {
        projectId,
        userId,
        role,
      },
      include: {
        user: { select: USER_SELECT },
      },
    });
  }

  async updateMemberRole(
    projectId: string,
    userId: string,
    role: ProjectMemberRole,
  ): Promise<ProjectMemberWithUser> {
    return this.prisma.projectMember.update({
      where: {
        projectId_userId: {
          projectId,
          userId,
        },
      },
      data: { role },
      include: {
        user: { select: USER_SELECT },
      },
    });
  }

  async deleteMember(projectId: string, userId: string): Promise<void> {
    if (!isUuid(projectId) || !isUuid(userId)) return;

    await this.prisma.projectMember.delete({
      where: {
        projectId_userId: {
          projectId,
          userId,
        },
      },
    });
  }

  async countAdmins(projectId: string): Promise<number> {
    if (!isUuid(projectId)) return 0;

    return this.prisma.projectMember.count({
      where: {
        projectId,
        role: ProjectMemberRole.admin,
      },
    });
  }

  async findWorkspaceMemberRole(
    workspaceId: string,
    userId: string,
  ): Promise<string | null> {
    if (!isUuid(workspaceId) || !isUuid(userId)) return null;

    const member = await this.prisma.workspaceMember.findFirst({
      where: { workspaceId, userId },
      select: { role: true },
    });
    return member?.role || null;
  }

  async findProject(projectId: string): Promise<{
    id: string;
    workspaceId: string;
    leadId: string | null;
  } | null> {
    if (!isUuid(projectId)) return null;

    return this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: {
        id: true,
        workspaceId: true,
        leadId: true,
      },
    });
  }

  async unassignMemberTasks(
    projectId: string,
    userId: string,
  ): Promise<number> {
    if (!isUuid(projectId) || !isUuid(userId)) return 0;

    const result = await this.prisma.task.updateMany({
      where: {
        projectId,
        assigneeId: userId,
        deletedAt: null,
      },
      data: {
        assigneeId: null,
      },
    });
    return result.count;
  }

  async clearProjectLeadIfMatches(
    projectId: string,
    userId: string,
  ): Promise<void> {
    if (!isUuid(projectId) || !isUuid(userId)) return;

    await this.prisma.project.updateMany({
      where: {
        id: projectId,
        leadId: userId,
      },
      data: {
        leadId: null,
      },
    });
  }
}
