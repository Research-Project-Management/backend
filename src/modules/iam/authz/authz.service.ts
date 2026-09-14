import { Injectable, Logger, ForbiddenException } from '@nestjs/common';
import { RedisCacheService } from '@/core/cache/redis.service';
import { Permission } from './enums/permission.enum';
import { Role, RoleHierarchy } from './enums/role.enum';
import {
  ROLE_PERMISSIONS,
  getPermissionsForRole,
  roleHasPermission,
} from './constants/permission.constant';
import { IAM_REDIS_KEYS } from '../core/constants/redis.constant';
import { AuthzRepository } from './authz.repository';

@Injectable()
export class AuthzService {
  private readonly logger = new Logger(AuthzService.name);
  private static readonly ROLE_CACHE_TTL = 600; // 10 minutes

  constructor(
    private readonly repo: AuthzRepository,
    private readonly redis: RedisCacheService,
  ) {}

  /**
   * Check if a role has a specific permission.
   */
  hasPermission(role: Role | string, permission: Permission): boolean {
    return roleHasPermission(role as Role, permission);
  }

  /**
   * Retrieve all permissions mapped to a given role.
   */
  getRolePermissions(role: Role | string): readonly Permission[] {
    return getPermissionsForRole(role as Role);
  }

  /**
   * Check if a user's role meets or exceeds a minimum role hierarchy.
   */
  hasRole(userRole: Role | string, minRole: Role): boolean {
    const userLevel = RoleHierarchy[userRole as Role] || 0;
    const requiredLevel = RoleHierarchy[minRole] || 0;
    return userLevel >= requiredLevel;
  }

  /**
   * Fetch a user's role in a given project with Redis caching.
   */
  async getRole(projectId: string, userId: string): Promise<Role | null> {
    if (!projectId || !userId) return null;

    const cacheKey = IAM_REDIS_KEYS.role(projectId, userId);

    // Check Redis cache first
    try {
      const cachedRole = await this.redis.get<Role>(cacheKey);
      if (cachedRole) return cachedRole;
    } catch (err) {
      this.logger.warn(`Redis getRole cache miss/error: ${err}`);
    }

    // 1. Check if user is Project Creator -> OWNER
    const project = await this.repo.findProjectContext(projectId);

    if (project && project.createdById === userId) {
      await this.redis
        .set(cacheKey, Role.OWNER, AuthzService.ROLE_CACHE_TTL)
        .catch(() => {});
      return Role.OWNER;
    }

    // 2. Query ProjectMember record
    const role = await this.repo.findMemberRole(projectId, userId);

    if (role) {
      await this.redis
        .set(cacheKey, role, AuthzService.ROLE_CACHE_TTL)
        .catch(() => {});
      return role;
    }

    return null;
  }

  /**
   * Enforce that a user has at least minRole in a project.
   */
  async requireRole(
    projectId: string,
    userId: string,
    minRole: Role,
  ): Promise<Role> {
    const role = await this.getRole(projectId, userId);
    if (!role) {
      throw new ForbiddenException(
        'Access denied: You are not a member of this project',
      );
    }

    if (!this.hasRole(role, minRole)) {
      throw new ForbiddenException(
        `Access denied: Required role is ${minRole}, current role is ${role}`,
      );
    }

    return role;
  }

  /**
   * Enforce that a user has a specific permission in a project.
   */
  async requirePermission(
    projectId: string,
    userId: string,
    permission: Permission,
  ): Promise<Role> {
    const role = await this.getRole(projectId, userId);
    if (!role) {
      throw new ForbiddenException(
        'Access denied: You are not a member of this project',
      );
    }

    if (!this.hasPermission(role, permission)) {
      throw new ForbiddenException(
        `Access denied: Missing required permission '${permission}'`,
      );
    }

    return role;
  }

  /**
   * Evicts the cached role for a user in a project.
   */
  async invalidateRoleCache(projectId: string, userId: string): Promise<void> {
    const cacheKey = IAM_REDIS_KEYS.role(projectId, userId);
    await this.redis.del(cacheKey).catch(() => {});
  }

  // ─── Direct Project Method Aliases ─────────────────────────────────────────

  async getProjectMemberRole(
    projectId: string,
    userId: string,
  ): Promise<Role | null> {
    return this.getRole(projectId, userId);
  }

  hasProjectPermission(role: Role | string, permission: Permission): boolean {
    return this.hasPermission(role, permission);
  }

  async requireProjectPermission(
    projectId: string,
    userId: string,
    permission: Permission,
  ): Promise<Role> {
    return this.requirePermission(projectId, userId, permission);
  }
}
