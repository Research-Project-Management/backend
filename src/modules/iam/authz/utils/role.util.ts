import { Role, RoleHierarchy, ROLE_DESCRIPTIONS } from '../enums/role.enum';
import { Permission } from '../enums/permission.enum';
import { ROLE_PERMISSIONS } from '../constants/permission.constant';

/**
 * Returns numeric hierarchy weight for a role.
 */
export function getRoleWeight(role: Role | string): number {
  return RoleHierarchy[role as Role] || 0;
}

/**
 * Compares two roles by hierarchy level.
 * Returns > 0 if roleA > roleB, 0 if equal, < 0 if roleA < roleB.
 */
export function compareRoles(
  roleA: Role | string,
  roleB: Role | string,
): number {
  return getRoleWeight(roleA) - getRoleWeight(roleB);
}

/**
 * Checks if a user's role satisfies a required minimum role.
 */
export function isRoleAtLeast(userRole: Role | string, minRole: Role): boolean {
  return getRoleWeight(userRole) >= getRoleWeight(minRole);
}

/**
 * Returns user-friendly metadata for a given role.
 */
export function getRoleMetadata(role: Role) {
  return (
    ROLE_DESCRIPTIONS[role] || {
      label: role,
      description: '',
    }
  );
}

/**
 * Checks if a role includes a domain permission.
 */
export function roleIncludesPermission(
  role: Role,
  permission: Permission,
): boolean {
  const granted = ROLE_PERMISSIONS[role];
  return granted ? granted.includes(permission) : false;
}
