import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '@/core/database/prisma.service';
import {
  PROJECT_ROLES_KEY,
  ProjectRoleInput,
} from '../decorators/project-roles.decorator';
import { ProjectRole, ProjectRoleHierarchy } from '../enums/project-role.enum';
import { WorkspaceRole } from '../enums/workspace-role.enum';

@Injectable()
export class ProjectRoleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.getAllAndOverride<ProjectRoleInput[]>(
      PROJECT_ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    const request = context.switchToHttp().getRequest();
    const user = request.user;
    if (!user || (!user.sub && !user.id)) {
      throw new ForbiddenException('User is not authenticated');
    }

    const userId = user.sub || user.id;

    // 1. Resolve project identifier
    let projectId =
      request.params?.projectId ||
      request.headers?.['x-project-id'] ||
      request.query?.projectId ||
      request.body?.projectId;

    // Resolve project from taskId if present
    if (
      !projectId &&
      (request.params?.taskId || request.params?.id) &&
      this.prisma?.task
    ) {
      const taskIdToLookup = request.params?.taskId || request.params?.id;
      const task = await this.prisma.task.findUnique({
        where: { id: taskIdToLookup },
        select: { projectId: true },
      });
      if (task?.projectId) {
        projectId = task.projectId;
      }
    }

    // Resolve project from pageId if present
    if (!projectId && request.params?.pageId && this.prisma?.page) {
      const page = await this.prisma.page.findUnique({
        where: { id: request.params.pageId },
        select: { projectId: true },
      });
      if (page?.projectId) {
        projectId = page.projectId;
      }
    }

    // Resolve project from cycleId if present
    if (!projectId && request.params?.cycleId && this.prisma?.cycle) {
      const cycle = await this.prisma.cycle.findUnique({
        where: { id: request.params.cycleId },
        select: { projectId: true },
      });
      if (cycle?.projectId) {
        projectId = cycle.projectId;
      }
    }

    // Resolve project from fileId if present
    if (!projectId && request.params?.fileId && this.prisma?.file) {
      const file = await this.prisma.file.findUnique({
        where: { id: request.params.fileId },
        select: { linkedToType: true, linkedToId: true },
      });
      if (file?.linkedToType === 'project' && file.linkedToId) {
        projectId = file.linkedToId;
      }
    }

    // Direct /project/:id fallback
    if (
      !projectId &&
      request.params?.id &&
      !request.params?.workspaceId &&
      !request.params?.pageId &&
      !request.params?.taskId &&
      !request.params?.fileId
    ) {
      projectId = request.params.id;
    }

    if (!projectId) {
      if (requiredRoles && requiredRoles.length > 0) {
        throw new ForbiddenException(
          'Project context is required for this operation',
        );
      }
      return true;
    }

    // 2. Fetch project
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, workspaceId: true },
    });

    if (!project) {
      throw new ForbiddenException('Project not found');
    }

    // 3. Workspace OWNER/ADMIN super-permission bypass
    const workspaceMember = await this.prisma.workspaceMember.findFirst({
      where: {
        workspaceId: project.workspaceId,
        userId,
      },
    });

    if (
      workspaceMember &&
      ((workspaceMember.role as unknown as WorkspaceRole) ===
        WorkspaceRole.OWNER ||
        (workspaceMember.role as unknown as WorkspaceRole) ===
          WorkspaceRole.ADMIN)
    ) {
      request.project = project;
      request.projectId = projectId;
      request.workspaceId = project.workspaceId;
      request.projectRole = ProjectRole.ADMIN;
      return true;
    }

    // 4. Project Membership check
    const projectMember = await this.prisma.projectMember.findFirst({
      where: {
        projectId,
        userId,
      },
    });

    if (!projectMember) {
      throw new ForbiddenException('You are not a member of this project');
    }

    request.project = project;
    request.projectId = projectId;
    request.workspaceId = project.workspaceId;
    request.projectMember = projectMember;
    request.projectRole = projectMember.role;

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    // 5. Evaluate role hierarchy
    const roleMapping: Record<string, ProjectRole> = {
      ADMIN: ProjectRole.ADMIN,
      admin: ProjectRole.ADMIN,
      OWNER: ProjectRole.ADMIN,
      owner: ProjectRole.ADMIN,
      LEAD: ProjectRole.ADMIN,
      lead: ProjectRole.ADMIN,
      RESEARCHER: ProjectRole.CONTRIBUTOR,
      researcher: ProjectRole.CONTRIBUTOR,
      CONTRIBUTOR: ProjectRole.CONTRIBUTOR,
      contributor: ProjectRole.CONTRIBUTOR,
      COMMENTER: ProjectRole.COMMENTER,
      commenter: ProjectRole.COMMENTER,
      VIEWER: ProjectRole.VIEWER,
      viewer: ProjectRole.VIEWER,
      MEMBER: ProjectRole.CONTRIBUTOR,
      member: ProjectRole.CONTRIBUTOR,
    };

    const rawMemberRole = projectMember.role as string;
    const memberRole =
      roleMapping[rawMemberRole] ||
      roleMapping[rawMemberRole.toUpperCase()] ||
      ProjectRole.VIEWER;
    const memberLevel = ProjectRoleHierarchy[memberRole] || 0;

    const isAllowed = requiredRoles.some((role) => {
      const roleStr = String(role);
      const normalized =
        roleMapping[roleStr] ||
        roleMapping[roleStr.toUpperCase()] ||
        ProjectRole.VIEWER;
      const requiredLevel = ProjectRoleHierarchy[normalized] || 0;
      return memberLevel >= requiredLevel;
    });

    if (!isAllowed) {
      throw new ForbiddenException(
        `Insufficient project permissions. Required: ${requiredRoles.join(', ')}`,
      );
    }

    return true;
  }
}
