import {
  IdentityAuthResult,
  IdentityUserSession,
} from '../types/identity.type';
import { SecurityAuditLogEntry } from '../../audit/types/audit.type';

export const IDENTITY_FACADE_TOKEN = Symbol('IDENTITY_FACADE_TOKEN');

/**
 * Unified Identity Facade Contract
 *
 * The sole contract through which external modules (project, document, library, etc.)
 * interact with Identity domain capabilities. Encapsulates user accounts, authentication
 * token verification, and security auditing.
 */
export interface IIdentityFacade {
  /**
   * Validates a JWT bearer token and extracts the authenticated user session.
   */
  verifyToken(token: string): Promise<IdentityAuthResult>;

  /**
   * Retrieves an active user session by user ID.
   */
  validateUser(userId: string): Promise<IdentityUserSession | null>;

  /**
   * Fetch full user profile details.
   */
  getUserById(userId: string): Promise<unknown>;

  /**
   * Fetch user by email address.
   */
  getUserByEmail(email: string): Promise<unknown>;

  /**
   * Search users across the platform.
   */
  searchUsers(
    query: string,
    excludeUserId?: string,
  ): Promise<{
    users: Array<{
      id: string;
      name: string;
      email: string;
      avatar: string | null;
    }>;
  }>;

  /**
   * Get resource statistics for a user dashboard.
   */
  getUserStats(userId: string): Promise<{ stats: unknown }>;

  /**
   * Dispatches a security audit event into the CADF audit pipeline.
   */
  recordAudit(entry: SecurityAuditLogEntry): Promise<void>;
}
