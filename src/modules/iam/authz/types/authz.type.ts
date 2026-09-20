import { Role } from '../enums/role.enum';
import { Permission } from '../enums/permission.enum';

/**
 * Subject context evaluated during authorization.
 */
export interface AuthzSubjectContext {
  readonly userId: string;
  readonly projectId?: string;
  readonly role?: Role;
  readonly permissions?: readonly Permission[];
}

/**
 * Result of checking a permission or role.
 */
export interface AuthzCheckResult {
  readonly allowed: boolean;
  readonly role: Role | null;
  readonly missingPermission?: Permission;
  readonly reason?: string;
}

/**
 * Minimal project metadata needed for authorization.
 */
export interface AuthzProjectContext {
  readonly id: string;
  readonly createdById: string;
}

/**
 * Abstraction layer for database queries backing AuthZ decisions.
 */
export interface IAuthzRepository {
  findProjectContext(projectId: string): Promise<AuthzProjectContext | null>;
  findMemberRole(projectId: string, userId: string): Promise<Role | null>;
  findMemberContext(projectId: string, userId: string): Promise<any>;
}
