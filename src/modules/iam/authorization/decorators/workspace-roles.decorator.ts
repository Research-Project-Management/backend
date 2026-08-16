import { SetMetadata } from '@nestjs/common';
import { WorkspaceRole } from '../enums/workspace-role.enum';
import { WorkspaceMemberRole } from '@prisma/client';

export const WORKSPACE_ROLES_KEY = 'workspace_roles';

export type WorkspaceRoleInput =
  | WorkspaceRole
  | WorkspaceMemberRole
  | 'owner'
  | 'admin'
  | 'member'
  | 'viewer';

export const WorkspaceRoles = (...roles: WorkspaceRoleInput[]) =>
  SetMetadata(WORKSPACE_ROLES_KEY, roles);

// Alias for general workspace roles
export const Roles = WorkspaceRoles;
