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
    const prismaAny = this.prisma as any;
    let resolvedProjectId: string | undefined;

    // 1. Explicit project route parameter (/projects/:projectId or /project/:id)
    const explicitProjectId =
      request.params?.projectId ||
      (request.params?.id && request.url?.includes('/project')
        ? request.params.id
        : undefined);

    if (explicitProjectId) {
      if (isUUID(explicitProjectId)) {
        resolvedProjectId = explicitProjectId;
      } else if (prismaAny.project?.findFirst) {
        const project = await Promise.resolve(
          prismaAny.project.findFirst({
            where: {
              identifier: { equals: explicitProjectId, mode: 'insensitive' },
              deletedAt: null,
            },
            select: { id: true },
          }),
        ).catch(() => null);
        if (project?.id) resolvedProjectId = project.id;
      }
    }

    // 2. Sub-resource lookup from URL parameters (cycleId, workItemId, pageId)
    if (!resolvedProjectId) {
      if (
        request.params?.cycleId &&
        isUUID(request.params.cycleId) &&
        prismaAny.cycle?.findUnique
      ) {
        const cycle = await Promise.resolve(
          prismaAny.cycle.findUnique({
            where: { id: request.params.cycleId },
            select: { projectId: true },
          }),
        ).catch(() => null);
        if (cycle?.projectId) resolvedProjectId = cycle.projectId;
      } else if (request.params?.workItemId && prismaAny.workItem?.findFirst) {
        const workItemId = request.params.workItemId;
        const where = isUUID(workItemId)
          ? { id: workItemId }
          : { identifier: { equals: workItemId, mode: 'insensitive' } };
        const workItem = await Promise.resolve(
          prismaAny.workItem.findFirst({
            where,
            select: { projectId: true },
          }),
        ).catch(() => null);
        if (workItem?.projectId) resolvedProjectId = workItem.projectId;
      } else if (
        request.params?.commentId &&
        isUUID(request.params.commentId) &&
        prismaAny.workItemComment?.findUnique
      ) {
        const comment = await Promise.resolve(
          prismaAny.workItemComment.findUnique({
            where: { id: request.params.commentId },
            select: { workItem: { select: { projectId: true } } },
          }),
        ).catch(() => null);
        if (comment?.workItem?.projectId)
          resolvedProjectId = comment.workItem.projectId;
      } else if (
        request.params?.pageId &&
        isUUID(request.params.pageId) &&
        prismaAny.page?.findUnique
      ) {
        const page = await Promise.resolve(
          prismaAny.page.findUnique({
            where: { id: request.params.pageId },
            select: { projectId: true },
          }),
        ).catch(() => null);
        if (page?.projectId) resolvedProjectId = page.projectId;
      }
    }

    // 3. Extract client-supplied header, query, or body projectId
    const rawHeaderProjectId =
      request.headers?.['x-project-id'] ||
      request.query?.projectId ||
      request.body?.projectId;

    let normalizedHeaderProjectId: string | undefined;
    if (rawHeaderProjectId) {
      if (isUUID(rawHeaderProjectId)) {
        normalizedHeaderProjectId = rawHeaderProjectId;
      } else if (prismaAny.project?.findFirst) {
        const project = await Promise.resolve(
          prismaAny.project.findFirst({
            where: {
              identifier: { equals: rawHeaderProjectId, mode: 'insensitive' },
              deletedAt: null,
            },
            select: { id: true },
          }),
        ).catch(() => null);
        if (project?.id) normalizedHeaderProjectId = project.id;
      }
    }

    // 4. Anti-BOLA / IDOR cross-verification
    if (resolvedProjectId && normalizedHeaderProjectId) {
      if (
        resolvedProjectId.toLowerCase() !==
        normalizedHeaderProjectId.toLowerCase()
      ) {
        throw new ForbiddenException(
          'Access denied: Resource does not belong to the specified project context (Cross-project violation)',
        );
      }
    }

    return resolvedProjectId || normalizedHeaderProjectId;
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
        this.logger.warn(
          `Redis role cache lookup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const prismaAny = this.prisma as any;
    if (prismaAny.projectMember?.findUnique) {
      // 1. Query ProjectMember record first (SSOT for member role)
      const member = await Promise.resolve(
        prismaAny.projectMember.findUnique({
          where: {
            projectId_userId: {
              projectId,
              userId,
            },
          },
        }),
      ).catch(() => null);

      if (member) {
        const role = member.role as unknown as Role;
        if (this.redis) {
          await this.redis
            .set(cacheKey, role, PermissionGuard.ROLE_CACHE_TTL)
            .catch(() => {});
        }
        return role;
      }
    }

    if (!prismaAny.project) return null;

    // 2. Fallback: Creator -> OWNER
    const project = await Promise.resolve(
      prismaAny.project.findFirst({
        where: { id: projectId, deletedAt: null },
        select: { id: true, createdById: true },
      }),
    ).catch(() => null);

    if (project && project.createdById === userId) {
      if (this.redis) {
        await this.redis
          .set(cacheKey, Role.OWNER, PermissionGuard.ROLE_CACHE_TTL)
          .catch(() => {});
      }
      return Role.OWNER;
    }

    return null;
  }
}

// ─── Backward Compatibility Alias ────────────────────────────────────────────
export const PermissionsGuard = PermissionGuard;
export type PermissionsGuard = PermissionGuard;
