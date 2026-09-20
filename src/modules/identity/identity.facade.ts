import { Injectable, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserService } from './user/user.service';
import { UserRepository } from './user/user.repository';
import { AuditService } from './audit/audit.service';
import { IIdentityFacade } from './core/interfaces/identity.interface';
import {
  IdentityAuthResult,
  IdentityUserSession,
} from './core/types/identity.type';
import { SecurityAuditLogEntry } from './audit/types/audit.type';

// Re-export interface, types, constants and audit definitions for consumers
export * from './core/interfaces/identity.interface';
export * from './core/types/identity.type';
export * from './core/constants/identity.constant';
export {
  SecurityAuditLogEntry,
  AUDIT_ACTIONS,
  AuditOutcome,
  AuditSeverity,
} from './audit/types/audit.type';

/**
 * Unified Identity Facade Service
 *
 * Serves as the sole public gateway to the Identity Domain for all external modules.
 * Strictly encapsulates internal sub-modules (auth, user, audit) and exposes high-level,
 * domain-agnostic capabilities (authentication verification, user queries, security auditing).
 */
@Injectable()
export class IdentityFacade implements IIdentityFacade {
  constructor(
    private readonly userService: UserService,
    private readonly userRepository: UserRepository,
    private readonly auditService: AuditService,
    private readonly jwtService: JwtService,
  ) {}

  // ── Authentication & Token Verification ──────────────────────────────────

  /**
   * Validates a JWT bearer token and extracts the authenticated user session.
   */
  async verifyToken(token: string): Promise<IdentityAuthResult> {
    try {
      const payload = await this.jwtService.verifyAsync<{ sub?: string }>(
        token,
      );
      if (!payload || !payload.sub || typeof payload.sub !== 'string') {
        return { valid: false, error: 'Invalid token payload' };
      }

      const user = await this.userRepository.findById(payload.sub);
      if (
        !user ||
        user.status === 'suspended' ||
        user.status === 'deactivated'
      ) {
        return {
          valid: false,
          error: 'User is inactive, suspended or not found',
        };
      }

      const session: IdentityUserSession = {
        userId: user.id,
        email: user.email || '',
        name: user.profile?.name ?? 'User',
        avatar: user.profile?.avatar ?? null,
        status: user.status,
        isVerified: user.status === 'active',
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
  async validateUser(userId: string): Promise<IdentityUserSession | null> {
    const user = await this.userRepository.findById(userId);
    if (!user || user.status === 'suspended' || user.status === 'deactivated') {
      return null;
    }
    return {
      userId: user.id,
      email: user.email || '',
      name: user.profile?.name ?? 'User',
      avatar: user.profile?.avatar ?? null,
      status: user.status,
      isVerified: user.status === 'active',
    };
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

  // ── Security & Audit Dispatch ────────────────────────────────────────────

  /**
   * Dispatches a structured security audit event through the CADF pipeline.
   * Enables external modules to log security actions without accessing Audit internals.
   */
  async recordAudit(entry: SecurityAuditLogEntry): Promise<void> {
    await this.auditService.record(entry);
  }
}

export const IdentityService = IdentityFacade;
export type IdentityService = IdentityFacade;
