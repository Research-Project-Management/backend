import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { ProjectMemberRole, Prisma } from '@prisma/client';
import { MinimalUser } from '../core/types/project.type';
import { ProjectMemberWithUser, FindMembersOptions } from './types/member.type';
import { isUuid } from '@/core/utils/uuid.util';

const USER_SELECT = {
  id: true,
  name: true,
  email: true,
  avatar: true,
} as const;

@Injectable()
export class MemberRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Find a specific member in a project.
   */
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

  /**
   * Find all members in a project with optional filters and pagination.
   */
  async findMembers(
    projectId: string,
    options?: FindMembersOptions,
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

  /**
   * Count members matching filter criteria.
   */
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

  /**
   * Add a member to a project.
   */
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

  /**
   * Update a member's role in a project.
   */
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

  /**
   * Delete a membership record.
   */
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

  /**
   * Count how many members currently have the 'owner' role in a project.
   */
  async countOwners(projectId: string): Promise<number> {
    if (!isUuid(projectId)) return 0;

    return this.prisma.projectMember.count({
      where: {
        projectId,
        role: ProjectMemberRole.owner,
      },
    });
  }

  /**
   * Verify that a user exists and is not soft-deleted.
   */
  async findUser(userId: string): Promise<MinimalUser | null> {
    if (!isUuid(userId)) return null;

    return this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: USER_SELECT,
    });
  }

  /**
   * Check if project exists.
   */
  async findProject(projectId: string): Promise<{
    id: string;
  } | null> {
    if (!isUuid(projectId)) return null;

    return this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: {
        id: true,
      },
    });
  }

  /**
   * Unassign active work items assigned to a member who is leaving/removed from the project.
   */
  async unassignMemberWorkItems(
    projectId: string,
    userId: string,
  ): Promise<number> {
    if (!isUuid(projectId) || !isUuid(userId)) return 0;

    const result = await this.prisma.workItem.updateMany({
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
}
