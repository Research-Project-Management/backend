import { SetMetadata, CustomDecorator } from '@nestjs/common';
import { WorkspaceRole } from '../enums/workspace-role.enum';

export const WORKSPACE_ROLES_KEY = 'workspace_roles';

export type WorkspaceRoleInput =
  | WorkspaceRole
  | `${WorkspaceRole}`
  | 'owner'
  | 'admin'
  | 'member'
  | 'viewer'
  | (string & {});

/**
 * Decorator to enforce workspace-level role permissions on routes
 */
export const WorkspaceRoles = (
  ...roles: WorkspaceRoleInput[]
): CustomDecorator<string> => SetMetadata(WORKSPACE_ROLES_KEY, roles);
