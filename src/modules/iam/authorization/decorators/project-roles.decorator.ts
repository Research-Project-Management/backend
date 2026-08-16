import { SetMetadata } from '@nestjs/common';
import { ProjectRole } from '../enums/project-role.enum';
import { ProjectMemberRole } from '@prisma/client';

export const PROJECT_ROLES_KEY = 'project_roles';

export type ProjectRoleInput =
  | ProjectRole
  | ProjectMemberRole
  | 'admin'
  | 'contributor'
  | 'commenter'
  | 'viewer';

export const ProjectRoles = (...roles: ProjectRoleInput[]) =>
  SetMetadata(PROJECT_ROLES_KEY, roles);
