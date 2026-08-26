import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { RedisCacheService } from '@/core/cache/redis-cache.service';
import { Permission } from './enums/permissions.enum';
import { WorkspaceRole } from './enums/workspace-role.enum';
import { ProjectRole } from './enums/project-role.enum';
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
