/**
 * Authorization (Authz) Module
 * Provides project-level RBAC guards, role decorators, permission validation,
 * and authorization caching via Redis.
 */
import { Module } from '@nestjs/common';
import { AuthzController } from './authz.controller';
import { AuthzService } from './authz.service';
import { AuthzRepository } from './authz.repository';
import { RoleGuard, RolesGuard, ProjectRoleGuard } from './guards/role.guard';
import { PermissionGuard, PermissionsGuard } from './guards/permission.guard';

@Module({
  controllers: [AuthzController],
  providers: [AuthzService, AuthzRepository, RoleGuard, PermissionGuard],
  exports: [AuthzService, AuthzRepository, RoleGuard, PermissionGuard],
})
export class AuthzModule {}
