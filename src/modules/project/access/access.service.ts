import {
  Injectable,
  Logger,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { RedisCacheService } from '@/core/cache/redis.service';
import { Permission } from './enums/permission.enum';
import { Role, RoleHierarchy } from './enums/role.enum';
import {
  ROLE_PERMISSIONS,
  getPermissionsForRole,
  evaluateMemberPermission,
  roleHasPermission,
} from './constants/permission.constant';
import { PROJECT_ACCESS_REDIS_KEYS } from './constants/redis.constant';
import { AccessRepository } from './access.repository';
import {
  MemberAccessContext,
  PermissionOverrideMap,
} from './types/access.type';

@Injectable()
export class AccessService {
  private readonly logger = new Logger(AccessService.name);
  private static readonly ACCESS_CACHE_TTL = 600; // 10 minutes

  constructor(
    private readonly repo: AccessRepository,
    private readonly redis: RedisCacheService,
  ) {}

  /**
   * Fetches the member's complete access context (Role, Overrides, Effective Permissions)
   * with ultra-fast Redis caching.
   */
  async getMemberAccessContext(
    projectId: string,
    userId: string,
  ): Promise<MemberAccessContext | null> {
    if (!projectId || !userId) return null;

    const cacheKey = PROJECT_ACCESS_REDIS_KEYS.context(projectId, userId);

    // 1. Try Redis cache first
    try {
      const cached = await this.redis.get<MemberAccessContext>(cacheKey);
      if (cached) return cached;
    } catch (err) {
      this.logger.warn(
        `Redis access context cache lookup error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // 2. Query Repository
    const context = await this.repo.findMemberAccessContext(projectId, userId);
    if (context) {
      await this.redis
        .set(cacheKey, context, AccessService.ACCESS_CACHE_TTL)
        .catch(() => {});
      return context;
    }

    return null;
  }

  /**
   * Fetches a user's role in a project.
   */
  async getRole(projectId: string, userId: string): Promise<Role | null> {
    const context = await this.getMemberAccessContext(projectId, userId);
    return context ? context.role : null;
  }

  /**
   * Evaluates if a given role + overrides allows a specific permission.
   * Priority: OWNER Superuser -> Explicit Override -> Role Baseline.
   */
  hasPermission(
    role: Role | string,
    permission: Permission,
    overrides?: PermissionOverrideMap | null,
  ): boolean {
    return evaluateMemberPermission(role as Role, permission, overrides);
  }

  /**
   * Retrieves default baseline permissions mapped to a given role.
   */
  getRolePermissions(role: Role | string): readonly Permission[] {
    return getPermissionsForRole(role as Role);
  }

  /**
   * Checks if user's role meets or exceeds a minimum role hierarchy level.
   */
  hasRole(userRole: Role | string, minRole: Role): boolean {
    const userLevel = RoleHierarchy[userRole as Role] || 0;
    const requiredLevel = RoleHierarchy[minRole] || 0;
    return userLevel >= requiredLevel;
  }

  /**
   * Enforces that a user has at least minRole in a project.
   */
  async requireRole(
    projectId: string,
    userId: string,
    minRole: Role,
  ): Promise<MemberAccessContext> {
    const context = await this.getMemberAccessContext(projectId, userId);
    if (!context) {
      throw new ForbiddenException(
        'Access denied: You are not a member of this project',
      );
    }

    if (!this.hasRole(context.role, minRole)) {
      throw new ForbiddenException(
        `Access denied: Required role is ${minRole}, current role is ${context.role}`,
      );
    }

    return context;
  }

  /**
   * Enforces that a user has a specific permission in a project.
   * Seamlessly checks Owner bypass -> Explicit Overrides -> Role Baseline.
   */
  async requirePermission(
    projectId: string,
    userId: string,
    permission: Permission,
  ): Promise<MemberAccessContext> {
    const context = await this.getMemberAccessContext(projectId, userId);
    if (!context) {
      throw new ForbiddenException(
        'Access denied: You are not a member of this project',
      );
    }

    if (
      !this.hasPermission(context.role, permission, context.permissionOverrides)
    ) {
      throw new ForbiddenException(
        `Access denied: Missing required permission '${permission}'`,
      );
    }

    return context;
  }

  /**
   * Evicts cached access context and role keys from Redis.
   */
  async invalidateAccessCache(
    projectId: string,
    userId: string,
  ): Promise<void> {
    const contextKey = PROJECT_ACCESS_REDIS_KEYS.context(projectId, userId);
    const legacyRoleKey = PROJECT_ACCESS_REDIS_KEYS.role(projectId, userId);

    await Promise.all([
      this.redis.del(contextKey).catch(() => {}),
      this.redis.del(legacyRoleKey).catch(() => {}),
    ]);
  }

  // ─── Backward Compatibility Aliases ────────────────────────────────────────

  async invalidateRoleCache(projectId: string, userId: string): Promise<void> {
    return this.invalidateAccessCache(projectId, userId);
  }

  async getProjectMemberRole(
    projectId: string,
    userId: string,
  ): Promise<Role | null> {
    return this.getRole(projectId, userId);
  }

  hasProjectPermission(role: Role | string, permission: Permission): boolean {
    return roleHasPermission(role as Role, permission);
  }

  async requireProjectPermission(
    projectId: string,
    userId: string,
    permission: Permission,
  ): Promise<Role> {
    const ctx = await this.requirePermission(projectId, userId, permission);
    return ctx.role;
  }
}
