import { Injectable, Logger, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { RedisCacheService } from '@/core/cache/redis-cache.service';
import { Permission } from './enums/permissions.enum';
import {
  WorkspaceRole,
  WorkspaceRoleHierarchy,
} from './enums/workspace-role.enum';
import { ProjectRole, ProjectRoleHierarchy } from './enums/project-role.enum';
import {
  WORKSPACE_ROLE_PERMISSIONS,
  PROJECT_ROLE_PERMISSIONS,
} from './constants/permission-matrix.constant';
import { IAM_REDIS_KEYS } from '../constants/redis-keys.constant';

@Injectable()
export class AuthzService {
  private readonly logger = new Logger(AuthzService.name);
  private static readonly ROLE_CACHE_TTL = 600; // 10 minutes

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisCacheService,
  ) {}

  /**
   * Check if a workspace role has a specific permission
   */
  hasWorkspacePermission(
    role: WorkspaceRole | string,
    permission: Permission,
  ): boolean {
    const permissions = WORKSPACE_ROLE_PERMISSIONS[role as WorkspaceRole] || [];
    return permissions.includes(permission);
  }

  /**
   * Check if a project role has a specific permission
   */
  hasProjectPermission(
    role: ProjectRole | string,
    permission: Permission,
  ): boolean {
    const permissions = PROJECT_ROLE_PERMISSIONS[role as ProjectRole] || [];
    return permissions.includes(permission);
  }

  /**
   * General permission check for backward compatibility
   */
  hasPermission(role: WorkspaceRole | string, permission: Permission): boolean {
    return this.hasWorkspacePermission(role, permission);
  }

  /**
   * Fetch a user's role in a given workspace with Redis caching.
   */
  async getWorkspaceMemberRole(
    workspaceId: string,
    userId: string,
  ): Promise<WorkspaceRole | null> {
    if (!workspaceId || !userId) return null;

    const cacheKey = IAM_REDIS_KEYS.workspaceRole(workspaceId, userId);
    const cachedRole = await this.redis.get<WorkspaceRole>(cacheKey);
    if (cachedRole) return cachedRole;

    const member = await this.prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId,
          userId,
        },
      },
      select: { role: true },
    });
    if (!member) return null;

    const role = member.role as unknown as WorkspaceRole;
    await this.redis.set(cacheKey, role, AuthzService.ROLE_CACHE_TTL);
    return role;
  }

  /**
   * Fetch a user's role in a given project with Redis caching.
   */
  async getProjectMemberRole(
    projectId: string,
    userId: string,
  ): Promise<ProjectRole | null> {
    if (!projectId || !userId) return null;

    const cacheKey = IAM_REDIS_KEYS.projectRole(projectId, userId);
    const cachedRole = await this.redis.get<ProjectRole>(cacheKey);
    if (cachedRole) return cachedRole;

    const member = await this.prisma.projectMember.findUnique({
      where: {
        projectId_userId: {
          projectId,
          userId,
        },
      },
      select: { role: true },
    });
    if (!member) return null;

    const role = member.role as unknown as ProjectRole;
    await this.redis.set(cacheKey, role, AuthzService.ROLE_CACHE_TTL);
    return role;
  }

  /**
   * Invalidate cached role for a user in a workspace.
   */
  async invalidateWorkspaceRoleCache(
    workspaceId: string,
    userId: string,
  ): Promise<void> {
    const cacheKey = IAM_REDIS_KEYS.workspaceRole(workspaceId, userId);
    await this.redis.del(cacheKey);
  }

  /**
   * Invalidate cached role for a user in a project.
   */
  async invalidateProjectRoleCache(
    projectId: string,
    userId: string,
  ): Promise<void> {
    const cacheKey = IAM_REDIS_KEYS.projectRole(projectId, userId);
    await this.redis.del(cacheKey);
  }

  /**
   * Assert workspace membership and optionally required roles at service layer.
   */
  async assertWorkspaceMember(
    workspaceId: string,
    userId: string,
    allowedRoles?: (WorkspaceRole | string)[],
  ): Promise<{ workspaceId: string; role: WorkspaceRole }> {
    if (!workspaceId || !userId) {
      throw new ForbiddenException(
        'Workspace context and authenticated user are required',
      );
    }

    const role = await this.getWorkspaceMemberRole(workspaceId, userId);
    if (!role) {
      throw new ForbiddenException('You are not a member of this workspace');
    }

    if (allowedRoles && allowedRoles.length > 0) {
      const memberRole = (role as string).toUpperCase() as WorkspaceRole;
      const memberLevel = WorkspaceRoleHierarchy[memberRole] || 0;

      const isAllowed = allowedRoles.some((reqRole) => {
        const normalized = reqRole.toUpperCase() as WorkspaceRole;
        const requiredLevel = WorkspaceRoleHierarchy[normalized] || 0;
        return memberLevel >= requiredLevel;
      });

      if (!isAllowed) {
        throw new ForbiddenException(
          `Insufficient workspace permissions. Required: ${allowedRoles.join(', ')}`,
        );
      }
    }

    return { workspaceId, role };
  }

  /**
   * Assert project membership and optionally required roles at service layer.
   */
  async assertProjectMember(
    projectId: string,
    userId: string,
    allowedRoles?: (ProjectRole | string)[],
  ): Promise<{ projectId: string; role: ProjectRole }> {
    if (!projectId || !userId) {
      throw new ForbiddenException(
        'Project context and authenticated user are required',
      );
    }

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, workspaceId: true },
    });
    if (!project) {
      throw new ForbiddenException('Project not found');
    }

    // Workspace owner / admin superuser access
    const wsRole = await this.getWorkspaceMemberRole(
      project.workspaceId,
      userId,
    );
    const normalizedWsRole = wsRole?.toUpperCase() as WorkspaceRole | undefined;
    if (
      normalizedWsRole === WorkspaceRole.OWNER ||
      normalizedWsRole === WorkspaceRole.ADMIN
    ) {
      return { projectId, role: ProjectRole.ADMIN };
    }

    const role = await this.getProjectMemberRole(projectId, userId);
    if (!role) {
      throw new ForbiddenException('You are not a member of this project');
    }

    if (allowedRoles && allowedRoles.length > 0) {
      const memberRole = (role as string).toUpperCase() as ProjectRole;
      const memberLevel = ProjectRoleHierarchy[memberRole] || 0;

      const isAllowed = allowedRoles.some((reqRole) => {
        const normalized = reqRole.toUpperCase() as ProjectRole;
        const requiredLevel = ProjectRoleHierarchy[normalized] || 0;
        return memberLevel >= requiredLevel;
      });

      if (!isAllowed) {
        throw new ForbiddenException(
          `Insufficient project permissions. Required: ${allowedRoles.join(', ')}`,
        );
      }
    }

    return { projectId, role };
  }

  /**
   * Deprecated alias for backward compatibility
   */
  async getMemberRole(
    workspaceId: string,
    userId: string,
  ): Promise<string | null> {
    return this.getWorkspaceMemberRole(workspaceId, userId);
  }
}

// Backward compatibility alias
export const AuthorizationService = AuthzService;
export type AuthorizationService = AuthzService;
