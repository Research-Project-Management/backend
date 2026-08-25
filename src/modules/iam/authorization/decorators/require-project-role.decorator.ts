import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../authentication/guards/jwt-auth.guard';
import { ProjectRoleGuard } from '../guards/project-role.guard';
import { PROJECT_ROLES_KEY } from './project-roles.decorator';
import { ProjectRole } from '../enums/project-role.enum';

/**
 * Composite meta-decorator combining JwtAuthGuard, ProjectRoleGuard and required project role metadata.
 */
export function RequireProjectRole(
  ...roles: (ProjectRole | keyof typeof ProjectRole)[]
) {
  return applyDecorators(
    SetMetadata(PROJECT_ROLES_KEY, roles),
    UseGuards(JwtAuthGuard, ProjectRoleGuard),
  );
}
