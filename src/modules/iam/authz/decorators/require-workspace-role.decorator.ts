import { applyDecorators, UseGuards } from '@nestjs/common';
import { WorkspaceRole } from '../enums/workspace-role.enum';
import { WorkspaceRoleGuard } from '../guards/workspace-role.guard';
import { WorkspaceRoles } from './workspace-roles.decorator';
import { JwtAuthGuard } from '../../authn/guards/jwt-auth.guard';

/**
 * Composite decorator that binds JwtAuthGuard, WorkspaceRoleGuard and required workspace roles.
 */
export function RequireWorkspaceRole(...roles: WorkspaceRole[]) {
  return applyDecorators(
    UseGuards(JwtAuthGuard, WorkspaceRoleGuard),
    WorkspaceRoles(...roles),
  );
}
