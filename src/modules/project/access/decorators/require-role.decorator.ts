import {
  SetMetadata,
  createParamDecorator,
  ExecutionContext,
} from '@nestjs/common';
import { Role } from '../enums/role.enum';

export const ROLES_KEY = 'roles';
export const MIN_ROLE_KEY = 'min_role';

/**
 * Valid role inputs: strictly the 4 project roles, plus helper group 'member'.
 * (string & {}) permits transitional string literals from domain controllers.
 */
export type RoleInput =
  | Role
  | 'owner'
  | 'coordinator'
  | 'contributor'
  | 'reviewer'
  | 'commenter'
  | 'viewer'
  | 'member'
  | (string & {});

/**
 * Standard @Roles(...) decorator for specifying allowed roles on routes.
 * Usage:
 *   @Roles(Role.OWNER)
 *   @Roles(Role.OWNER, Role.COORDINATOR, Role.CONTRIBUTOR)
 *   @Roles('owner', 'coordinator', 'contributor')
 */
export const Roles = (...roles: RoleInput[]) =>
  SetMetadata(ROLES_KEY, roles as Role[]);

/**
 * Minimum hierarchy-based role requirement.
 * Usage:
 *   @RequireRole(Role.CONTRIBUTOR) // Allows OWNER, COORDINATOR, and CONTRIBUTOR
 *   @RequireRole(Role.REVIEWER)    // Allows OWNER, COORDINATOR, CONTRIBUTOR, and REVIEWER
 */
export const RequireRole = (minRole: Role) =>
  SetMetadata(MIN_ROLE_KEY, minRole);

/**
 * Injects the caller's resolved Project Role from request context.
 * Usage:
 *   @Get()
 *   myHandler(@CurrentRole() role: Role)
 */
export const CurrentRole = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Role | null => {
    const request = ctx.switchToHttp().getRequest();
    return request.role ?? null;
  },
);

// ─── Aliases & Compatibility Exports ─────────────────────────────────────────
export const PROJECT_ROLES_KEY = ROLES_KEY;
export const ProjectRoles = Roles;
export const RequireProjectRole = RequireRole;
export type ProjectRoleInput = RoleInput;
