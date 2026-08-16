import { Module } from '@nestjs/common';
import { AuthorizationService } from './authorization.service';
import { WorkspaceRoleGuard } from './guards/workspace-role.guard';
import { ProjectRoleGuard } from './guards/project-role.guard';

@Module({
  providers: [AuthorizationService, WorkspaceRoleGuard, ProjectRoleGuard],
  exports: [AuthorizationService, WorkspaceRoleGuard, ProjectRoleGuard],
})
export class AuthorizationModule {}
