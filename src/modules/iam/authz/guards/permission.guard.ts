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
import { PERMISSIONS_KEY } from '../decorators/permission.decorator';
import { Permission } from '../enums/permission.enum';
import { Role } from '../enums/role.enum';
import { ROLE_PERMISSIONS } from '../constants/permission.constant';
import { IAM_REDIS_KEYS } from '../../core/constants/redis.constant';

@Injectable()
export class PermissionGuard implements CanActivate {
  private readonly logger = new Logger(PermissionGuard.name);
  private static readonly ROLE_CACHE_TTL = 600; // 10 minutes

  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly redis?: RedisCacheService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredPermissions = this.reflector.getAllAndOverride<Permission[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;
    if (!user || (!user.sub && !user.id)) {
      throw new ForbiddenException('User is not authenticated');
    }

    const userId = user.sub || user.id;

    // Check if role has already been attached by RoleGuard
    let role: Role | null = request.role || null;

    if (!role) {
      const projectId = await this.resolveProjectId(request);
      if (!projectId) {
        throw new ForbiddenException(
          'Project context is required to evaluate permissions',
        );
      }

      role = await this.getProjectRole(projectId, userId);
      if (!role) {
        throw new ForbiddenException(
          'Access denied: You are not a member of this project',
        );
      }

      request.role = role;
    }

    const grantedPermissions = ROLE_PERMISSIONS[role] || [];
    request.permissions = grantedPermissions;

    const missingPermission = requiredPermissions.find(
      (perm) => !grantedPermissions.includes(perm),
    );

    if (missingPermission) {
      throw new ForbiddenException(
        `Access denied: Missing required permission '${missingPermission}' for role '${role}'`,
      );
    }

    return true;
  }

  private async resolveProjectId(request: any): Promise<string | undefined> {
    const explicitProjectId =
      request.params?.projectId ||
      (request.params?.id && request.url?.includes('/project')
        ? request.params.id
        : undefined);

    if (explicitProjectId && isUUID(explicitProjectId)) {
      return explicitProjectId;
    }

    const headerProjectId =
      request.headers?.['x-project-id'] ||
      request.query?.projectId ||
      request.body?.projectId;

    if (headerProjectId && isUUID(headerProjectId)) {
      return headerProjectId;
    }

    const prismaAny = this.prisma as any;

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

    const taskId = request.params?.taskId;
    if (taskId && isUUID(taskId) && prismaAny.workItem) {
      const task = await prismaAny.workItem
        .findUnique({
          where: { id: taskId },
          select: { projectId: true },
        })
        .catch(() => null);
      if (task?.projectId) return task.projectId;
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

  private async getProjectRole(
    projectId: string,
    userId: string,
  ): Promise<Role | null> {
    const cacheKey = IAM_REDIS_KEYS.role(projectId, userId);

    if (this.redis) {
      try {
        const cachedRole = await this.redis.get<Role>(cacheKey);
        if (cachedRole) return cachedRole;
      } catch (err) {
        this.logger.warn(`Redis role cache lookup failed: ${err}`);
      }
    }

    const prismaAny = this.prisma as any;
    if (!prismaAny.project) return null;

    // 1. Creator -> OWNER
    const project = await prismaAny.project
      .findFirst({
        where: { id: projectId, deletedAt: null },
        select: { id: true, createdById: true },
      })
      .catch(() => null);

    if (project && project.createdById === userId) {
      if (this.redis) {
        await this.redis
          .set(cacheKey, Role.OWNER, PermissionGuard.ROLE_CACHE_TTL)
          .catch(() => {});
      }
      return Role.OWNER;
    }

    if (!prismaAny.projectMember) return null;

    // 2. ProjectMember
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
          .set(cacheKey, role, PermissionGuard.ROLE_CACHE_TTL)
          .catch(() => {});
      }
      return role;
    }

    return null;
  }
}

// ─── Backward Compatibility Alias ────────────────────────────────────────────
export const PermissionsGuard = PermissionGuard;
export type PermissionsGuard = PermissionGuard;
