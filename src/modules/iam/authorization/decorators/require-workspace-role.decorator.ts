import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../authentication/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '../guards/workspace-role.guard';
import { WORKSPACE_ROLES_KEY } from './workspace-roles.decorator';
import { WorkspaceRole } from '../enums/workspace-role.enum';

/**
 * Composite meta-decorator combining JwtAuthGuard, WorkspaceRoleGuard and required role metadata.
 * Matt Pocock High-Leverage Deep Decorator.
 *
 * @example
 * ```ts
 * @RequireWorkspaceRole(WorkspaceRole.admin)
 * @Delete(':id')
 * removeWorkspace() { ... }
 * ```
 */
export function RequireWorkspaceRole(
  ...roles: (WorkspaceRole | keyof typeof WorkspaceRole)[]
) {
  return applyDecorators(
    SetMetadata(WORKSPACE_ROLES_KEY, roles),
    UseGuards(JwtAuthGuard, WorkspaceRoleGuard),
  );
}
