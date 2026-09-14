import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '@/core/database/prisma.service';
import { RedisCacheService } from '@/core/cache/redis.service';
import { isUUID } from 'class-validator';
import { ROLES_KEY, MIN_ROLE_KEY, RoleInput } from '../decorators/role.decorator';
import { Role, RoleHierarchy } from '../enums/role.enum';
import { IAM_REDIS_KEYS } from '../../core/constants/redis.constant';

@Injectable()
export class RoleGuard implements CanActivate {
  private readonly logger = new Logger(RoleGuard.name);
  private static readonly ROLE_CACHE_TTL = 600; // 10 minutes

  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly redis?: RedisCacheService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.getAllAndOverride<RoleInput[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    const minRole = this.reflector.getAllAndOverride<Role>(
      MIN_ROLE_KEY,
      [context.getHandler(), context.getClass()],
    );

    // If no roles are specified, allow access (authentication handled by JwtAuthGuard)
    if (!requiredRoles && !minRole) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;
    if (!user || (!user.sub && !user.id)) {
      throw new ForbiddenException('User is not authenticated');
    }

    const userId = user.sub || user.id;

    // 1. Resolve Project ID
    const projectId = await this.resolveProjectId(request);

    // If route doesn't specify a project context, allow if authenticated
    if (!projectId) {
      return true;
    }

    // 2. Fetch User's Role in this Project
    const { role, member } = await this.getProjectRole(projectId, userId);

    if (!role) {
      throw new ForbiddenException(
        'Access denied: You are not a member of this project',
      );
    }

    // 3. Attach role and member context to request
    request.role = role;
    request.projectMember = member;

    // 4. Verify against required roles
    if (requiredRoles && requiredRoles.length > 0) {
      const isRoleAllowed = requiredRoles.some((r) => {
        const normalized = String(r).toLowerCase();
        if (normalized === 'member') {
          return role === Role.OWNER || role === Role.CONTRIBUTOR;
        }
        if (normalized === 'admin') {
          return role === Role.OWNER;
        }
        return normalized === role.toLowerCase();
      });

      if (!isRoleAllowed) {
        throw new ForbiddenException(
          `Access denied: Required role (${requiredRoles.join(', ')}), current role (${role})`,
        );
      }
    }

    // 5. Verify against minimum role hierarchy
    if (minRole) {
      const currentLevel = RoleHierarchy[role] || 0;
      const requiredLevel = RoleHierarchy[minRole] || 0;
      if (currentLevel < requiredLevel) {
        throw new ForbiddenException(
          `Access denied: Minimum role required is ${minRole}, current role is ${role}`,
        );
      }
    }

    return true;
  }

  /**
   * Resolves the projectId from request params, headers, query, body,
   * or by looking up child resources (cycle, WorkItem, page, sticky).
   */
  private async resolveProjectId(request: any): Promise<string | undefined> {
    const explicitProjectId =
      request.params?.projectId ||
      (request.params?.id && request.url?.includes('/project')
        ? request.params.id
        : undefined);

    const prismaAny = this.prisma as any;

    if (explicitProjectId) {
      if (isUUID(explicitProjectId)) {
        return explicitProjectId;
      }
      if (prismaAny.project) {
        const project = await prismaAny.project
          .findFirst({
            where: {
              identifier: { equals: explicitProjectId, mode: 'insensitive' },
              deletedAt: null,
            },
            select: { id: true },
          })
          .catch(() => null);
        if (project?.id) return project.id;
      }
    }

    const headerProjectId =
      request.headers?.['x-project-id'] ||
      request.query?.projectId ||
      request.body?.projectId;

    if (headerProjectId) {
      if (isUUID(headerProjectId)) {
        return headerProjectId;
      }
      if (prismaAny.project) {
        const project = await prismaAny.project
          .findFirst({
            where: {
              identifier: { equals: headerProjectId, mode: 'insensitive' },
              deletedAt: null,
            },
            select: { id: true },
          })
          .catch(() => null);
        if (project?.id) return project.id;
      }
    }

    // Lookup through sub-resources
    if (request.params?.cycleId && isUUID(request.params.cycleId) && prismaAny.cycle) {
      const cycle = await prismaAny.cycle
        .findUnique({
          where: { id: request.params.cycleId },
          select: { projectId: true },
        })
        .catch(() => null);
      if (cycle?.projectId) return cycle.projectId;
    }

    const workItemId = request.params?.workItemId;
    if (workItemId && prismaAny.workItem) {
      const where = isUUID(workItemId)
        ? { id: workItemId }
        : { identifier: { equals: workItemId, mode: 'insensitive' } };
      const workItem = await prismaAny.workItem
        .findFirst({
          where,
          select: { projectId: true },
        })
        .catch(() => null);
      if (workItem?.projectId) return workItem.projectId;
    }

    const commentId = request.params?.commentId;
    if (commentId && isUUID(commentId) && prismaAny.workItemComment) {
      const comment = await prismaAny.workItemComment
        .findUnique({
          where: { id: commentId },
          select: { workItem: { select: { projectId: true } } },
        })
        .catch(() => null);
      if (comment?.workItem?.projectId) return comment.workItem.projectId;
    }

    if (request.params?.pageId && isUUID(request.params.pageId) && prismaAny.page) {
      const page = await prismaAny.page
        .findUnique({
          where: { id: request.params.pageId },
          select: { projectId: true },
        })
        .catch(() => null);
      if (page?.projectId) return page.projectId;
    }

    return undefined;
  }

  /**
   * Retrieves the user's role in a project with Redis cache support.
   */
  private async getProjectRole(
    projectId: string,
    userId: string,
  ): Promise<{ role: Role | null; member: any }> {
    const cacheKey = IAM_REDIS_KEYS.role(projectId, userId);

    // Try Redis cache
    if (this.redis) {
      try {
        const cachedRole = await this.redis.get<Role>(cacheKey);
        if (cachedRole) {
          return { role: cachedRole, member: null };
        }
      } catch (err) {
        this.logger.warn(`Redis role cache lookup failed: ${err}`);
      }
    }

    const prismaAny = this.prisma as any;
    if (!prismaAny.project) {
      return { role: null, member: null };
    }

    // 1. Check if user is the Project Creator -> OWNER
    const project = await prismaAny.project
      .findFirst({
        where: { id: projectId, deletedAt: null },
        select: { id: true, createdById: true },
      })
      .catch(() => null);

    if (project && project.createdById === userId) {
      if (this.redis) {
        await this.redis
          .set(cacheKey, Role.OWNER, RoleGuard.ROLE_CACHE_TTL)
          .catch(() => {});
      }
      return { role: Role.OWNER, member: null };
    }

    if (!prismaAny.projectMember) {
      return { role: null, member: null };
    }

    // 2. Query ProjectMember table
    const member = await prismaAny.projectMember
      .findUnique({
        where: {
          projectId_userId: {
            projectId,
            userId,
          },
        },
      })
      .catch(() => null);

    if (member) {
      const role = member.role as unknown as Role;
      if (this.redis) {
        await this.redis
          .set(cacheKey, role, RoleGuard.ROLE_CACHE_TTL)
          .catch(() => {});
      }
      return { role, member };
    }

    return { role: null, member: null };
  }
}

// ─── Controller Compatibility Aliases ──────────────────────────────────────────
export const RolesGuard = RoleGuard;
export type RolesGuard = RoleGuard;

export const ProjectRoleGuard = RoleGuard;
export type ProjectRoleGuard = RoleGuard;

export const WorkspaceRoleGuard = RoleGuard;
export type WorkspaceRoleGuard = RoleGuard;
