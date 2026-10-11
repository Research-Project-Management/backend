import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '@/core';
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
    let projectId = await this.resolveProjectId(request);
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

      // Only dual-context library endpoints (which support both personal and project scopes)
      // are permitted to proceed in personal scope when no projectId is provided.
      const isDualContextLibraryRoute =
        (url.includes('/library') ||
          url.includes('/attachments') ||
          url.includes('/files')) &&
        (isParamProjectPersonal ||
          isUrlPersonalProject ||
          (!url.includes('/projects/') && !url.includes('/project/')));

      if (isDualContextLibraryRoute) {
        // Dual-context endpoint accessed in personal/user scope (e.g. personal library)
        return true;
      }

      throw new ForbiddenException(
        'Project context is required to enforce project permissions',
      );
    }

    // 5. Fetch Member Access Context (Role + Overrides + Effective Permissions)
    let accessContext = await this.accessService.getMemberAccessContext(
      projectId,
      userId,
    );

    if (!accessContext && isUUID(projectId)) {
      // Check if projectId is actually a document ID from manuscript_docs
      try {
        const doc = await this.prisma.manuscriptDoc.findUnique({
          where: { id: projectId },
          select: { projectId: true },
        });
        if (doc?.projectId) {
          projectId = doc.projectId;
          if (request.params) {
            request.params.projectId = doc.projectId;
          }
          accessContext = await this.accessService.getMemberAccessContext(
            projectId,
            userId,
          );
        }
      } catch (err) {
        this.logger.debug(
          `Project doc fallback resolution failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

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
  private async resolveProjectId(request: {
    params?: Record<string, string>;
    url?: string;
    body?: Record<string, unknown>;
    headers?: Record<string, string>;
    query?: Record<string, string>;
  }): Promise<string | undefined> {
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
      } else {
        const project = await this.prisma.project
          .findFirst({
            where: {
              identifier: { equals: explicitProjectId, mode: 'insensitive' },
              deletedAt: null,
            },
            select: { id: true },
          })
          .catch(() => null);
        if (project?.id) resolvedProjectId = project.id;
      }
    }

    // 2. Sub-resource lookup from URL parameters
    if (!resolvedProjectId) {
      if (request.params?.workItemId) {
        const workItemId = request.params.workItemId;
        const where = isUUID(workItemId)
          ? { id: workItemId }
          : { identifier: { equals: workItemId, mode: 'insensitive' as const } };
        const workItem = await this.prisma.workItem
          .findFirst({
            where,
            select: { projectId: true },
          })
          .catch(() => null);
        if (workItem?.projectId) resolvedProjectId = workItem.projectId;
      } else if (
        request.params?.commentId &&
        isUUID(request.params.commentId)
      ) {
        const comment = await this.prisma.workItemComment
          .findUnique({
            where: { id: request.params.commentId },
            select: { workItem: { select: { projectId: true } } },
          })
          .catch(() => null);
        if (comment?.workItem?.projectId) {
          resolvedProjectId = comment.workItem.projectId;
        }
      } else if (request.params?.assetId && isUUID(request.params.assetId)) {
        const file = await this.prisma.file
          .findUnique({
            where: { id: request.params.assetId },
            select: { linkedToId: true },
          })
          .catch(() => null);
        if (file?.linkedToId) resolvedProjectId = file.linkedToId;
      } else if (
        (request.params?.pageId ||
          request.params?.nodeId ||
          (typeof request.body?.pageId === 'string'
            ? request.body.pageId
            : undefined)) &&
        isUUID(
          request.params?.pageId ||
            request.params?.nodeId ||
            String(request.body?.pageId || ''),
        )
      ) {
        const targetId =
          request.params?.pageId ||
          request.params?.nodeId ||
          String(request.body?.pageId);
        const doc = await this.prisma.manuscriptDoc
          .findUnique({
            where: { id: targetId },
            select: { projectId: true },
          })
          .catch(() => null);
        if (doc?.projectId) resolvedProjectId = doc.projectId;
      }
    }

    // 3. Client-supplied header, query, or body projectId
    const rawHeaderProjectId =
      request.headers?.['x-project-id'] ||
      request.query?.projectId ||
      (typeof request.body?.projectId === 'string'
        ? request.body.projectId
        : undefined);

    let normalizedHeaderProjectId: string | undefined;
    if (rawHeaderProjectId) {
      if (isUUID(rawHeaderProjectId)) {
        normalizedHeaderProjectId = rawHeaderProjectId;
      } else {
        const project = await this.prisma.project
          .findFirst({
            where: {
              identifier: { equals: rawHeaderProjectId, mode: 'insensitive' },
              deletedAt: null,
            },
            select: { id: true },
          })
          .catch(() => null);
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
