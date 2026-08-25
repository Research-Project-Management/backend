import { applyDecorators, UseGuards } from '@nestjs/common';
import { ProjectRole } from '../enums/project-role.enum';
import { ProjectRoleGuard } from '../guards/project-role.guard';
import { ProjectRoles } from './project-roles.decorator';
import { JwtAuthGuard } from '../../authn/guards/jwt-auth.guard';

/**
 * Composite decorator that binds JwtAuthGuard, ProjectRoleGuard and required project roles.
 */
export function RequireProjectRole(...roles: ProjectRole[]) {
  return applyDecorators(
    UseGuards(JwtAuthGuard, ProjectRoleGuard),
    ProjectRoles(...roles),
  );
}
