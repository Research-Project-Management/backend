import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '@/core/database/prisma.service';
import { isUUID } from 'class-validator';
import {
  ROLES_KEY,
  MIN_ROLE_KEY,
  RoleInput,
} from '../decorators/require-role.decorator';
import { PERMISSIONS_KEY } from '../decorators/require-permission.decorator';
import { Role, RoleHierarchy } from '../enums/role.enum';
import { Permission } from '../enums/permission.enum';
import { AccessService } from '../access.service';
import { MemberAccessContext } from '../types/access.type';

@Injectable()
export class ProjectAccessGuard implements CanActivate {
  private readonly logger = new Logger(ProjectAccessGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly accessService: AccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // 1. Extract metadata from route handler and class
    const requiredRoles = this.reflector.getAllAndOverride<RoleInput[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    const minRole = this.reflector.getAllAndOverride<Role>(MIN_ROLE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const requiredPermissions = this.reflector.getAllAndOverride<Permission[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    // If no roles, minRole, or permissions are specified, allow access
    if (
      (!requiredRoles || requiredRoles.length === 0) &&
      !minRole &&
      (!requiredPermissions || requiredPermissions.length === 0)
    ) {
      return true;
    }

    // 3. Verify user authentication
    const request = context.switchToHttp().getRequest();
    const user = request.user;
    if (!user || (!user.sub && !user.id)) {
      throw new ForbiddenException('User is not authenticated');
    }

    const userId = user.sub || user.id;

    // 4. Resolve Project ID
    const projectId = await this.resolveProjectId(request);
    if (!projectId) {
      // If client explicitly requested a project context but it couldn't be resolved, reject
      const rawRequestedProject =
        request.headers?.['x-project-id'] ||
        request.query?.projectId ||
        request.body?.projectId;

      const hasExplicitProjectTarget =
        rawRequestedProject &&
        rawRequestedProject !== 'undefined' &&
        rawRequestedProject !== 'null' &&
        rawRequestedProject !== 'me' &&
        rawRequestedProject !== 'user' &&
        rawRequestedProject !== 'personal' &&
        rawRequestedProject !== 'global' &&
        rawRequestedProject !== 'default';

      if (hasExplicitProjectTarget) {
        throw new ForbiddenException(
          'Project context is invalid or project not found',
        );
      }

      // Check if the route is an explicit project route or has sub-resources requiring project context
      const url = request.url || request.raw?.url || '';
      const rawParamProject = request.params?.projectId;
      const isParamProjectPersonal =
        !rawParamProject ||
        rawParamProject === 'undefined' ||
        rawParamProject === 'null' ||
        rawParamProject === 'me' ||
        rawParamProject === 'user' ||
        rawParamProject === 'personal' ||
        rawParamProject === 'global' ||
        rawParamProject === 'default';

      const isUrlPersonalProject =
        url.includes('/projects/personal') ||
        url.includes('/projects/user') ||
        url.includes('/projects/me') ||
        url.includes('/project/personal') ||
        url.includes('/project/user') ||
        url.includes('/project/me');

      const isExplicitProjectRoute =
        (!isParamProjectPersonal && rawParamProject !== undefined) ||
        request.params?.cycleId !== undefined ||
        request.params?.workItemId !== undefined ||
        (url.includes('/projects/') && !isUrlPersonalProject) ||
        (url.includes('/project/') && !isUrlPersonalProject);

      if (!isExplicitProjectRoute || isParamProjectPersonal || isUrlPersonalProject) {
        // Dual-context endpoint accessed in personal/user scope (e.g. personal library)
        return true;
      }

      throw new ForbiddenException(
        'Project context is required to enforce project permissions',
      );
    }

    // 5. Fetch Member Access Context (Role + Overrides + Effective Permissions)
    const accessContext = await this.accessService.getMemberAccessContext(
      projectId,
      userId,
    );

    if (!accessContext) {
      throw new ForbiddenException(
        'Access denied: You are not a member of this project',
      );
    }

    // Attach access context to request for downstream handlers and decorators
    request.role = accessContext.role;
    request.projectMember = accessContext;
    request.accessContext = accessContext;
    request.permissions = accessContext.effectivePermissions;

    // 6. Verify against Required Roles (if configured)
    if (requiredRoles && requiredRoles.length > 0) {
      const isRoleAllowed = requiredRoles.some((r) => {
        const normalized = String(r).toLowerCase();
        if (normalized === 'member') {
          return (
            accessContext.role === Role.OWNER ||
            accessContext.role === Role.COORDINATOR ||
            accessContext.role === Role.CONTRIBUTOR ||
            accessContext.role === Role.REVIEWER
          );
        }
        if (normalized === 'admin') {
          return accessContext.role === Role.OWNER;
        }
        if (normalized === 'commenter' || normalized === 'viewer') {
          return accessContext.role === Role.REVIEWER;
        }
        return normalized === accessContext.role.toLowerCase();
      });

      if (!isRoleAllowed) {
        throw new ForbiddenException(
          `Access denied: Required role (${requiredRoles.join(', ')}), current role (${accessContext.role})`,
        );
      }
    }

    // 7. Verify against Minimum Role Hierarchy (if configured)
    if (minRole) {
      const currentLevel = RoleHierarchy[accessContext.role] || 0;
      const requiredLevel = RoleHierarchy[minRole] || 0;
      if (currentLevel < requiredLevel) {
        throw new ForbiddenException(
          `Access denied: Minimum role required is ${minRole}, current role is ${accessContext.role}`,
        );
      }
    }

    // 8. Verify against Required Permissions (with Granular Overrides + Owner Bypass)
    if (requiredPermissions && requiredPermissions.length > 0) {
      for (const permission of requiredPermissions) {
        const hasPerm = this.accessService.hasPermission(
          accessContext.role,
          permission,
          accessContext.permissionOverrides,
        );

        if (!hasPerm) {
          throw new ForbiddenException(
            `Access denied: Missing required permission '${permission}' for role '${accessContext.role}'`,
          );
        }
      }
    }

    return true;
  }

  /**
   * Securely resolves projectId from route parameters, sub-resources, or headers.
   * Cross-verifies with anti-BOLA/IDOR protection.
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

    // 2. Sub-resource lookup from URL parameters
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
          if (page?.projectId) resolvedProjectId = page.projectId;
        }
        if (!resolvedProjectId && prismaAny.file?.findUnique) {
          const file = await Promise.resolve(
            prismaAny.file.findUnique({
              where: { id: request.params.assetId },
              select: { linkedToId: true },
            }),
          ).catch(() => null);
          if (file?.linkedToId) resolvedProjectId = file.linkedToId;
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

    // 3. Client-supplied header, query, or body projectId
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
}

// ─── Backward Compatibility Aliases ──────────────────────────────────────────
export const RoleGuard = ProjectAccessGuard;
export type RoleGuard = ProjectAccessGuard;

export const RolesGuard = ProjectAccessGuard;
export type RolesGuard = ProjectAccessGuard;

export const ProjectRoleGuard = ProjectAccessGuard;
export type ProjectRoleGuard = ProjectAccessGuard;

export const PermissionGuard = ProjectAccessGuard;
export type PermissionGuard = ProjectAccessGuard;

export const PermissionsGuard = ProjectAccessGuard;
export type PermissionsGuard = ProjectAccessGuard;
