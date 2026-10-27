import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
  Logger,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '@/core';
import {
  ROLES_KEY,
  MIN_ROLE_KEY,
  RoleInput,
} from '../decorators/require-role.decorator';
import { PERMISSIONS_KEY } from '../decorators/require-permission.decorator';
import { NO_PROJECT_CONTEXT_KEY } from '../decorators/no-project-context.decorator';
import { REQUIRE_OPERATOR_KEY } from '../decorators/require-operator.decorator';
import { Role, RoleHierarchy } from '../enums/role.enum';
import { Permission } from '../enums/permission.enum';
import { AccessService } from '../access.service';
import { ProjectResourceResolver } from '../resolvers/project-resource.resolver';
import { AccessConfigService } from '../config/access.config';

@Injectable()
export class ProjectAccessGuard implements CanActivate {
  private readonly logger = new Logger(ProjectAccessGuard.name);
  private readonly resourceResolver: ProjectResourceResolver;

  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly accessService: AccessService,
    @Optional() resolver?: ProjectResourceResolver,
    @Optional() private readonly accessConfigService?: AccessConfigService,
  ) {
    this.resourceResolver = resolver || new ProjectResourceResolver(prisma);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handler = context.getHandler();
    const targetClass = context.getClass();

    // 1. Check for explicit NoProjectContext exemption
    const isNoProjectContext = this.reflector.getAllAndOverride<boolean>(
      NO_PROJECT_CONTEXT_KEY,
      [handler, targetClass],
    );
    if (isNoProjectContext) {
      return true;
    }

    // 2. Extract metadata from route handler and class
    const requiredRoles = this.reflector.getAllAndOverride<RoleInput[]>(
      ROLES_KEY,
      [handler, targetClass],
    );
    const minRole = this.reflector.getAllAndOverride<Role>(MIN_ROLE_KEY, [
      handler,
      targetClass,
    ]);
    const requiredPermissions = this.reflector.getAllAndOverride<Permission[]>(
      PERMISSIONS_KEY,
      [handler, targetClass],
    );
    const isOperatorRequired = this.reflector.getAllAndOverride<boolean>(
      REQUIRE_OPERATOR_KEY,
      [handler, targetClass],
    );

    const request = context.switchToHttp().getRequest();
    const user = request.user;
    const userId = user?.sub || user?.id;

    // 3. Verify user authentication
    if (!user || !userId) {
      throw new UnauthorizedException({
        statusCode: 401,
        code: 'AUTH_REQUIRED',
        message: 'Authentication required',
      });
    }

    // 4. Operator check if required
    if (isOperatorRequired) {
      const isOp = this.accessConfigService?.isOperator(userId) ?? false;
      if (!isOp) {
        throw new ForbiddenException({
          statusCode: 403,
          code: 'OPERATOR_REQUIRED',
          message: 'Operator privileges required',
        });
      }
      return true;
    }

    // 5. Handle undeclared routes (no role, minRole, or permission)
    const hasAccessPolicy =
      (requiredRoles && requiredRoles.length > 0) ||
      !!minRole ||
      (requiredPermissions && requiredPermissions.length > 0);

    if (!hasAccessPolicy) {
      const mode = this.accessConfigService?.enforcementMode || 'report';
      if (mode === 'enforce') {
        this.logger.warn(
          `Deny-by-default blocked access to undeclared route: ${request.method} ${request.url} by user ${userId}`,
        );
        throw new ForbiddenException({
          statusCode: 403,
          code: 'ACCESS_UNDECLARED',
          message: 'Access denied: Route has no declared access policy',
        });
      } else if (mode === 'report') {
        this.logger.warn(
          `Report-only: access to undeclared route permitted: ${request.method} ${request.url} by user ${userId}`,
        );
      }
      return true;
    }

    // 6. Authoritatively resolve project ID from resources / params / hints
    const resolvedResult =
      await this.resourceResolver.resolveAuthoritativeProjectId(request);

    if (!resolvedResult || !resolvedResult.projectId) {
      // Check if dual-context library route in personal scope
      const url = request.url || request.raw?.url || '';
      const isDualContextLibraryRoute =
        !url.includes('/manuscripts/') &&
        (url.includes('/library') ||
          url.includes('/attachments') ||
          url.includes('/files')) &&
        !url.includes('/projects/') &&
        !url.includes('/project/');

      if (isDualContextLibraryRoute) {
        return true;
      }

      throw new ForbiddenException({
        statusCode: 403,
        code: 'ACCESS_DENIED',
        message: 'Project context is required to enforce project permissions',
      });
    }

    const projectId = resolvedResult.projectId;
    request.resolvedProjectId = projectId;
    request.projectId = projectId;

    // 7. Verify project membership
    const accessContext = await this.accessService.getMemberAccessContext(
      projectId,
      userId,
    );

    if (!accessContext) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'ACCESS_DENIED',
        message: 'Access denied',
      });
    }

    // Attach access context to request for downstream handlers and decorators
    request.role = accessContext.role;
    request.projectMember = accessContext;
    request.accessContext = accessContext;
    request.permissions = accessContext.effectivePermissions;

    // 8. Verify against Required Roles (Specification Pattern)
    if (
      requiredRoles &&
      requiredRoles.length > 0 &&
      !ProjectRolePolicy.satisfiesRequiredRoles(
        accessContext.role,
        requiredRoles,
      )
    ) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'ROLE_INSUFFICIENT',
        message: 'Insufficient role for this action',
      });
    }

    // 9. Verify against Minimum Role Hierarchy (Specification Pattern)
    if (
      minRole &&
      !ProjectRolePolicy.satisfiesMinRole(accessContext.role, minRole)
    ) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'ROLE_INSUFFICIENT',
        message: 'Insufficient role for this action',
      });
    }

    // 10. Verify against Required Permissions (with Granular Overrides + Owner Bypass)
    if (requiredPermissions && requiredPermissions.length > 0) {
      for (const permission of requiredPermissions) {
        const hasPerm = this.accessService.hasPermission(
          accessContext.role,
          permission,
          accessContext.permissionOverrides,
        );

        if (!hasPerm) {
          throw new ForbiddenException({
            statusCode: 403,
            code: 'ROLE_INSUFFICIENT',
            message: 'Insufficient role for this action',
          });
        }
      }
    }

    return true;
  }
}

/**
 * Specification / Policy Pattern: Pure role & alias evaluation rules for Project Access.
 */
export class ProjectRolePolicy {
  public static matchesRoleOrAlias(
    actualRole: Role | string,
    requiredRoleOrAlias: Role | string,
  ): boolean {
    const normalizedReq = String(requiredRoleOrAlias).trim().toLowerCase();
    const normalizedActual = String(actualRole).trim().toLowerCase();

    if (normalizedReq === 'member') {
      return (
        normalizedActual === Role.OWNER ||
        normalizedActual === Role.COORDINATOR ||
        normalizedActual === Role.CONTRIBUTOR ||
        normalizedActual === Role.REVIEWER
      );
    }
    if (normalizedReq === 'admin') {
      return normalizedActual === Role.OWNER;
    }
    if (normalizedReq === 'commenter' || normalizedReq === 'viewer') {
      return normalizedActual === Role.REVIEWER;
    }
    return normalizedReq === normalizedActual;
  }

  public static satisfiesRequiredRoles(
    actualRole: Role | string,
    requiredRoles: ReadonlyArray<Role | string>,
  ): boolean {
    if (!requiredRoles || requiredRoles.length === 0) return true;
    return requiredRoles.some((req) =>
      this.matchesRoleOrAlias(actualRole, req),
    );
  }

  public static satisfiesMinRole(actualRole: Role, minRole: Role): boolean {
    const currentLevel = RoleHierarchy[actualRole] || 0;
    const requiredLevel = RoleHierarchy[minRole] || 0;
    return currentLevel >= requiredLevel;
  }
}

/** Backwards-compatibility alias for ProjectAccessGuard */
export const ProjectRoleGuard = ProjectAccessGuard;
export type ProjectRoleGuard = ProjectAccessGuard;
