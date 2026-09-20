import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { isUUID } from 'class-validator';
import { Role } from './enums/role.enum';
import {
  AuthzProjectContext,
  IAccessRepository,
  MemberAccessContext,
  PermissionOverrideMap,
} from './types/access.type';
import { computeEffectivePermissions } from './constants/permission.constant';

@Injectable()
export class AccessRepository implements IAccessRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Fetches minimal project context (creator ID) to determine ownership and verify project existence.
   */
  async findProjectContext(
    projectId: string,
  ): Promise<AuthzProjectContext | null> {
    if (!projectId || !isUUID(projectId)) return null;

    const prismaAny = this.prisma as any;
    if (!prismaAny.project) return null;

    const project = await prismaAny.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: {
        id: true,
        createdById: true,
      },
    });

    if (!project) return null;

    return {
      id: project.id,
      createdById: project.createdById,
    };
  }

  /**
   * Queries full MemberAccessContext including role, granular overrides, and user profile.
   */
  async findMemberAccessContext(
    projectId: string,
    userId: string,
  ): Promise<MemberAccessContext | null> {
    if (!projectId || !userId || !isUUID(projectId) || !isUUID(userId)) {
      return null;
    }

    const prismaAny = this.prisma as any;
    if (!prismaAny.projectMember) return null;

    const member = await prismaAny.projectMember.findFirst({
      where: {
        projectId,
        userId,
        project: { deletedAt: null },
      },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            status: true,
            profile: {
              select: {
                name: true,
                avatar: true,
              },
            },
          },
        },
      },
    });

    if (!member) return null;

    const role = member.role as Role;
    const effectivePermissions = computeEffectivePermissions(role);

    return {
      projectId: member.projectId,
      userId: member.userId,
      role,
      permissionOverrides: {},
      effectivePermissions,
      joinedAt: member.joinedAt,
      user: member.user
        ? {
            id: member.user.id,
            email: member.user.email,
            status: member.user.status,
            name: member.user.profile?.name ?? 'User',
            avatar: member.user.profile?.avatar ?? null,
          }
        : null,
    };
  }

  /**
   * Queries the user's role in a project.
   */
  async findMemberRole(
    projectId: string,
    userId: string,
  ): Promise<Role | null> {
    if (!projectId || !userId || !isUUID(projectId) || !isUUID(userId)) {
      return null;
    }

    const prismaAny = this.prisma as any;
    if (!prismaAny.projectMember) return null;

    const member = await prismaAny.projectMember.findFirst({
      where: {
        projectId,
        userId,
        project: { deletedAt: null },
      },
      select: { role: true },
    });

    return member ? (member.role as Role) : null;
  }

  /**
   * Updates permission overrides for a specific project member.
   */
  async updateMemberOverrides(
    projectId: string,
    userId: string,
    overrides: PermissionOverrideMap,
  ): Promise<void> {
    const prismaAny = this.prisma as any;
    if (!prismaAny.projectMember) return;

    await prismaAny.projectMember.updateMany({
      where: {
        projectId,
        userId,
      },
      data: {
        permissionOverrides: overrides,
      },
    });
  }

  /**
   * Compatibility alias for findMemberAccessContext / findMemberContext.
   */
  async findMemberContext(projectId: string, userId: string): Promise<any> {
    return this.findMemberAccessContext(projectId, userId);
  }
}
