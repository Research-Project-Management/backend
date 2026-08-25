import { Module } from '@nestjs/common';
import { AuthzService } from './authz.service';
import { WorkspaceRoleGuard } from './guards/workspace-role.guard';
import { ProjectRoleGuard } from './guards/project-role.guard';

@Module({
  providers: [AuthzService, WorkspaceRoleGuard, ProjectRoleGuard],
  exports: [AuthzService, WorkspaceRoleGuard, ProjectRoleGuard],
})
export class AuthzModule {}

// Backward compatibility alias
export const AuthorizationModule = AuthzModule;
