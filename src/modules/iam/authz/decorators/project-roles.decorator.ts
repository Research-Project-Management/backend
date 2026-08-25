import { SetMetadata, CustomDecorator } from '@nestjs/common';
import { ProjectRole } from '../enums/project-role.enum';

export const PROJECT_ROLES_KEY = 'project_roles';

export type ProjectRoleInput =
  | ProjectRole
  | `${ProjectRole}`
  | 'owner'
  | 'lead'
  | 'researcher'
  | 'contributor'
  | 'commenter'
  | 'viewer'
  | 'admin'
  | 'member'
  | (string & {});

/**
 * Decorator to enforce project-level role permissions on routes
 */
export const ProjectRoles = (
  ...roles: ProjectRoleInput[]
): CustomDecorator<string> => SetMetadata(PROJECT_ROLES_KEY, roles);
