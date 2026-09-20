import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { ProjectMemberRole, Prisma } from '@prisma/client';
import { MinimalUser } from '../core/types/project.type';
import { ProjectMemberWithUser, FindMembersOptions } from './types/member.type';
import { isUuid } from '@/core/utils/uuid.util';

const USER_SELECT = {
  id: true,
  email: true,
  profile: {
    select: {
      name: true,
      avatar: true,
    },
  },
} as const;

function mapMember<T extends { user: { id: string; email: string | null; profile?: { name: string; avatar: string | null } | null } }>(
  member: T,
): Omit<T, 'user'> & { user: MinimalUser } {
  return {
    ...member,
    user: {
      id: member.user.id,
      email: member.user.email,
      name: member.user.profile?.name ?? 'User',
      avatar: member.user.profile?.avatar ?? null,
    },
  };
}

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

    const member = await this.prisma.projectMember.findUnique({
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

    return member ? mapMember(member) : null;
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
            {
              profile: {
                name: { contains: options.search, mode: 'insensitive' },
              },
            },
            { email: { contains: options.search, mode: 'insensitive' } },
          ],
        },
      }),
    };

    const members = await this.prisma.projectMember.findMany({
      where,
      include: {
        user: { select: USER_SELECT },
      },
      orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
      ...(options?.take ? { take: options.take } : {}),
      ...(options?.skip ? { skip: options.skip } : {}),
    });

    return members.map(mapMember);
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
            {
              profile: {
                name: { contains: options.search, mode: 'insensitive' },
              },
            },
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
    const member = await this.prisma.projectMember.create({
      data: {
        projectId,
        userId,
        role,
      },
      include: {
        user: { select: USER_SELECT },
      },
    });

    return mapMember(member);
  }

  /**
   * Update a member's role in a project.
   */
  async updateMemberRole(
    projectId: string,
    userId: string,
    role: ProjectMemberRole,
  ): Promise<ProjectMemberWithUser> {
    const member = await this.prisma.projectMember.update({
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

    return mapMember(member);
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

    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: USER_SELECT,
    });
    if (!user) return null;
    return {
      id: user.id,
      email: user.email,
      name: user.profile?.name ?? 'User',
      avatar: user.profile?.avatar ?? null,
    };
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

  /**
   * Atomically transfer project ownership from current owner to another member.
   * Demotes current owner to coordinator and elevates target member to owner.
   */
  async transferOwnership(
    projectId: string,
    currentOwnerId: string,
    newOwnerId: string,
  ): Promise<{
    previousOwner: ProjectMemberWithUser;
    newOwner: ProjectMemberWithUser;
  }> {
    return this.prisma.$transaction(async (tx) => {
      await tx.project.update({
        where: { id: projectId },
        data: { createdById: newOwnerId },
      });

      const previousOwner = await tx.projectMember.update({
        where: {
          projectId_userId: {
            projectId,
            userId: currentOwnerId,
          },
        },
        data: { role: ProjectMemberRole.coordinator },
        include: {
          user: { select: USER_SELECT },
        },
      });

      const newOwner = await tx.projectMember.update({
        where: {
          projectId_userId: {
            projectId,
            userId: newOwnerId,
          },
        },
        data: { role: ProjectMemberRole.owner },
        include: {
          user: { select: USER_SELECT },
        },
      });

      return {
        previousOwner: mapMember(previousOwner),
        newOwner: mapMember(newOwner),
      };
    });
  }
}
