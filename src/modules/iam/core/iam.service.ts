import {
  Injectable,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserService } from '../user/user.service';
import { UserRepository } from '../user/user.repository';
import { AuthzService } from '../authz/authz.service';
import { Role } from '../authz/enums/role.enum';
import { Permission } from '../authz/enums/permission.enum';
import { IamAuthResult, IamUserSession } from './types/iam.type';

/**
 * IAM Gateway & Unified Facade Service
 *
 * Acts as the single entry/exit point (cổng ra) of the entire IAM context.
 * Designed to decouple consumer modules from internal IAM implementations,
 * allowing effortless transition to a dedicated gRPC / HTTP microservice.
 */
@Injectable()
export class IamService {
  constructor(
    private readonly userService: UserService,
    private readonly userRepository: UserRepository,
    private readonly authzService: AuthzService,
    private readonly jwtService: JwtService,
  ) {}

  // ── Authentication & Token Verification ──────────────────────────────────

  /**
   * Validates a JWT bearer token and extracts the authenticated user session.
   */
  async verifyToken(token: string): Promise<IamAuthResult> {
    try {
      const payload = await this.jwtService.verifyAsync(token);
      if (!payload || !payload.sub) {
        return { valid: false, error: 'Invalid token payload' };
      }

      const user = await this.userRepository.findById(payload.sub);
      if (!user || user.status !== 'active') {
        return { valid: false, error: 'User is inactive or not found' };
      }

      const session: IamUserSession = {
        userId: user.id,
        email: user.email || '',
        name: user.profile?.name ?? 'User',
        avatar: user.profile?.avatar ?? null,
        status: user.status,
      };

      return { valid: true, user: session };
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Token verification failed';
      return { valid: false, error: message };
    }
  }

  /**
   * Retrieves an active user session by user ID.
   */
  async validateUser(userId: string): Promise<IamUserSession | null> {
    const user = await this.userRepository.findById(userId);
    if (!user || user.status !== 'active') {
      return null;
    }
    return {
      userId: user.id,
      email: user.email || '',
      name: user.profile?.name ?? 'User',
      avatar: user.profile?.avatar ?? null,
      status: user.status,
    };
  }

  // ── Authorization & Access Control ───────────────────────────────────────

  /**
   * Resolves the user's role within a project (null if not a member).
   */
  async getUserProjectRole(
    userId: string,
    projectId: string,
  ): Promise<Role | null> {
    return this.authzService.getRole(projectId, userId);
  }

  /**
   * Check if a user possesses a specific permission within a project.
   */
  async hasPermission(
    userId: string,
    projectId: string,
    permission: Permission,
  ): Promise<boolean> {
    const role = await this.authzService.getRole(projectId, userId);
    if (!role) return false;
    return this.authzService.hasPermission(role, permission);
  }

  /**
   * Asserts that a user has a specific permission in a project, throwing ForbiddenException if not.
   */
  async requirePermission(
    userId: string,
    projectId: string,
    permission: Permission,
  ): Promise<void> {
    await this.authzService.requirePermission(projectId, userId, permission);
  }

  /**
   * Checks if user has at least the specified minimum role in a project.
   */
  async checkRole(
    userId: string,
    projectId: string,
    minRole: Role,
  ): Promise<boolean> {
    const role = await this.authzService.getRole(projectId, userId);
    if (!role) return false;
    return this.authzService.hasRole(role, minRole);
  }

  /**
   * Asserts that a user has at least the specified role in a project.
   */
  async requireRole(
    userId: string,
    projectId: string,
    minRole: Role,
  ): Promise<void> {
    await this.authzService.requireRole(projectId, userId, minRole);
  }

  /**
   * Returns all granted permissions for a user within a project.
   */
  async getProjectPermissions(
    userId: string,
    projectId: string,
  ): Promise<string[]> {
    const role = await this.authzService.getRole(projectId, userId);
    if (!role) return [];
    return [...this.authzService.getRolePermissions(role)];
  }

  // ── User Identity & Account Queries ──────────────────────────────────────

  /**
   * Fetch full user profile details.
   */
  async getUserById(userId: string) {
    const user = await this.userRepository.findById(userId);
    if (!user) {
      throw new NotFoundException(`User with ID ${userId} not found`);
    }
    return user;
  }

  /**
   * Fetch user by email address.
   */
  async getUserByEmail(email: string) {
    return this.userRepository.findByEmail(email);
  }

  /**
   * Search users across the platform.
   */
  async searchUsers(query: string, excludeUserId?: string) {
    return this.userService.searchUsers(query, excludeUserId);
  }

  /**
   * Get resource statistics for a user dashboard.
   */
  async getUserStats(userId: string) {
    return this.userService.getUserStats(userId);
  }
}
