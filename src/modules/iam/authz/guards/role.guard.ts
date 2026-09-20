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
import {
  ROLES_KEY,
  MIN_ROLE_KEY,
  RoleInput,
} from '../decorators/role.decorator';
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
    if (process.env.STANDALONE_LIBRARY === 'true') {
      return true;
    }

    const requiredRoles = this.reflector.getAllAndOverride<RoleInput[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    const minRole = this.reflector.getAllAndOverride<Role>(MIN_ROLE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

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
          return (
            role === Role.OWNER ||
            role === Role.COORDINATOR ||
            role === Role.CONTRIBUTOR ||
            role === Role.REVIEWER
          );
        }
        if (normalized === 'admin') {
          return role === Role.OWNER;
        }
        // Legacy compatibility: map commenter/viewer to reviewer
        if (normalized === 'commenter' || normalized === 'viewer') {
          return role === Role.REVIEWER;
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
   * Resolves the projectId securely from request params, sub-resources, or headers.
   * Prevents BOLA/IDOR by prioritizing URL resource context and cross-verifying
   * against any client-supplied header/body/query projectId.
   */
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

    // 2. Sub-resource lookup from URL parameters (cycleId, workItemId, commentId, pageId)
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
        isUUID(request.params.commentId)
      ) {
        if (prismaAny.workItemComment?.findUnique) {
          const comment = await Promise.resolve(
            prismaAny.workItemComment.findUnique({
              where: { id: request.params.commentId },
              select: { workItem: { select: { projectId: true } } },
            }),
          ).catch(() => null);
          if (comment?.workItem?.projectId) {
            resolvedProjectId = comment.workItem.projectId;
          }
        }
        if (!resolvedProjectId && prismaAny.pageComment?.findUnique) {
          const pageComment = await Promise.resolve(
            prismaAny.pageComment.findUnique({
              where: { id: request.params.commentId },
              select: { page: { select: { projectId: true } } },
            }),
          ).catch(() => null);
          if (pageComment?.page?.projectId) {
            resolvedProjectId = pageComment.page.projectId;
          }
        }
      } else if (request.params?.assetId && isUUID(request.params.assetId)) {
        if (prismaAny.page?.findUnique) {
          const page = await Promise.resolve(
            prismaAny.page.findUnique({
              where: { id: request.params.assetId },
              select: { projectId: true },
            }),
          ).catch(() => null);
          if (page?.projectId) {
            resolvedProjectId = page.projectId;
          }
        }
        if (!resolvedProjectId && prismaAny.file?.findUnique) {
          const file = await Promise.resolve(
            prismaAny.file.findUnique({
              where: { id: request.params.assetId },
              select: { linkedToId: true },
            }),
          ).catch(() => null);
          if (file?.linkedToId) {
            resolvedProjectId = file.linkedToId;
          }
        }
      } else if (
        (request.params?.pageId ||
          request.params?.nodeId ||
          request.body?.pageId) &&
        isUUID(
          request.params?.pageId ||
            request.params?.nodeId ||
            request.body?.pageId,
        ) &&
        prismaAny.page?.findUnique
      ) {
        const targetId =
          request.params?.pageId ||
          request.params?.nodeId ||
          request.body?.pageId;
        const page = await Promise.resolve(
          prismaAny.page.findUnique({
            where: { id: targetId },
            select: { projectId: true },
          }),
        ).catch(() => null);
        if (page?.projectId) resolvedProjectId = page.projectId;
      }
    }

    // 3. Extract any client-supplied header, query, or body projectId
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
    // If the resource belongs to a resolved project, any client-specified projectId MUST match!
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

    // Return the verified resolved project, or fallback to header/body project if creating new resource
    return resolvedProjectId || normalizedHeaderProjectId;
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
        this.logger.warn(
          `Redis role cache lookup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const prismaAny = this.prisma as any;
    if (prismaAny.projectMember?.findUnique) {
      // 1. Query ProjectMember table first (SSOT for member role)
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
            .set(cacheKey, role, RoleGuard.ROLE_CACHE_TTL)
            .catch(() => {});
        }
        return { role, member };
      }
    }

    if (!prismaAny.project) {
      return { role: null, member: null };
    }

    // 2. Fallback: Check if user is the Project Creator -> OWNER
    const project = await Promise.resolve(
      prismaAny.project.findFirst({
        where: { id: projectId, deletedAt: null },
        select: { id: true, createdById: true },
      }),
    ).catch(() => null);

    if (project && project.createdById === userId) {
      if (this.redis) {
        await this.redis
          .set(cacheKey, Role.OWNER, RoleGuard.ROLE_CACHE_TTL)
          .catch(() => {});
      }
      return { role: Role.OWNER, member: null };
    }

    return { role: null, member: null };
  }
}

// ─── Controller Compatibility Aliases ──────────────────────────────────────────
export const RolesGuard = RoleGuard;
export type RolesGuard = RoleGuard;

export const ProjectRoleGuard = RoleGuard;
export type ProjectRoleGuard = RoleGuard;
