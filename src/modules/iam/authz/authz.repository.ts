import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { isUUID } from 'class-validator';
import { Role } from './enums/role.enum';
import { IAuthzRepository, AuthzProjectContext } from './types/authz.type';

@Injectable()
export class AuthzRepository implements IAuthzRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Fetches minimal project context (creator ID) to determine ownership.
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
   * Queries the direct ProjectMember record for the given user in project.
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

    const member = await prismaAny.projectMember.findUnique({
      where: {
        projectId_userId: {
          projectId,
          userId,
        },
      },
      select: { role: true },
    });

    return member ? member.role : null;
  }

  /**
   * Fetches full member context including user details.
   */
  async findMemberContext(
    projectId: string,
    userId: string,
  ): Promise<any | null> {
    if (!projectId || !userId || !isUUID(projectId) || !isUUID(userId)) {
      return null;
    }

    const prismaAny = this.prisma as any;
    if (!prismaAny.projectMember) return null;

    return prismaAny.projectMember.findUnique({
      where: {
        projectId_userId: {
          projectId,
          userId,
        },
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            avatar: true,
          },
        },
      },
    });
  }
}
