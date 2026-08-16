import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { Permission } from './enums/permissions.enum';
import { WorkspaceRole } from './enums/workspace-role.enum';
import { ProjectRole } from './enums/project-role.enum';
import {
  WORKSPACE_ROLE_PERMISSIONS,
  PROJECT_ROLE_PERMISSIONS,
} from './constants/permission-matrix';

@Injectable()
export class AuthorizationService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Check if a workspace role has a specific permission
   */
  hasWorkspacePermission(
    role: WorkspaceRole | string,
    permission: Permission,
  ): boolean {
    const permissions =
      WORKSPACE_ROLE_PERMISSIONS[role as WorkspaceRole] || [];
    return permissions.includes(permission);
  }

  /**
   * Check if a project role has a specific permission
   */
  hasProjectPermission(
    role: ProjectRole | string,
    permission: Permission,
  ): boolean {
    const permissions =
      PROJECT_ROLE_PERMISSIONS[role as ProjectRole] || [];
    return permissions.includes(permission);
  }

  /**
   * General permission check for backward compatibility
   */
  hasPermission(role: WorkspaceRole | string, permission: Permission): boolean {
    return this.hasWorkspacePermission(role, permission);
  }

  /**
   * Fetch a user's role in a given workspace
   */
  async getWorkspaceMemberRole(
    workspaceId: string,
    userId: string,
  ): Promise<WorkspaceRole | null> {
    const member = await this.prisma.workspaceMember.findFirst({
      where: { workspaceId, userId },
      select: { role: true },
    });
    return (member?.role as WorkspaceRole) ?? null;
  }

  /**
   * Fetch a user's role in a given project
   */
  async getProjectMemberRole(
    projectId: string,
    userId: string,
  ): Promise<ProjectRole | null> {
    const member = await this.prisma.projectMember.findFirst({
      where: { projectId, userId },
      select: { role: true },
    });
    return (member?.role as ProjectRole) ?? null;
  }

  /**
   * Deprecated alias for backward compatibility
   */
  async getMemberRole(
    workspaceId: string,
    userId: string,
  ): Promise<string | null> {
    return this.getWorkspaceMemberRole(workspaceId, userId);
  }
}
