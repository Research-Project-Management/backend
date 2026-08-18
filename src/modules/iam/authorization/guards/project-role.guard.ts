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

    // 1. Resolve projectId
    let projectId =
      request.params?.projectId ||
      request.headers?.['x-project-id'] ||
      request.query?.projectId ||
      request.body?.projectId;

    if (
      !projectId &&
      request.params?.id &&
      request.baseUrl?.includes('project')
    ) {
      projectId = request.params.id;
    }

    if (!projectId && request.params?.pageId) {
      try {
        const page = await this.prisma.page.findUnique({
          where: { id: request.params.pageId },
          select: { projectId: true },
        });
        if (page?.projectId) {
          projectId = page.projectId;
        }
      } catch {
        // Ignore invalid UUID or lookup failure
      }
    }

    if (!projectId && request.params?.taskId) {
      try {
        const task = await this.prisma.task.findUnique({
          where: { id: request.params.taskId },
          select: { projectId: true },
        });
        if (task?.projectId) {
          projectId = task.projectId;
        }
      } catch {
        // Ignore invalid UUID or lookup failure
      }
    }

    if (!projectId && request.params?.cycleId) {
      try {
        const cycle = await this.prisma.cycle.findUnique({
          where: { id: request.params.cycleId },
          select: { projectId: true },
        });
        if (cycle?.projectId) {
          projectId = cycle.projectId;
        }
      } catch {
        // Ignore invalid UUID or lookup failure
      }
    }

    if (!projectId) {
      if (requiredRoles && requiredRoles.length > 0) {
        throw new ForbiddenException(
          'Project context is required for this operation',
        );
      }
      return true;
    }

    // 2. Fetch project along with workspace membership check
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        workspaceId: true,
        members: {
          where: { userId },
          select: { role: true, joinedAt: true },
        },
      },
    });

    if (!project) {
      throw new ForbiddenException('Project not found or inaccessible');
    }

    // 3. Check if user is Workspace Owner/Admin (Inherited Admin Escalation)
    const wsMember = await this.prisma.workspaceMember.findFirst({
      where: {
        workspaceId: project.workspaceId,
        userId,
      },
      select: { role: true },
    });

    const isWorkspaceAdminOrOwner =
      wsMember?.role === WorkspaceRole.OWNER ||
      wsMember?.role === WorkspaceRole.ADMIN;

    const projectMember = project.members[0];

    // User must be at least a project member OR a workspace admin/owner
    if (!projectMember && !isWorkspaceAdminOrOwner) {
      throw new ForbiddenException('You are not a member of this project');
    }

    request.projectMember = projectMember || {
      role: ProjectRole.ADMIN,
      userId,
      projectId,
    };
    request.projectId = projectId;
    request.workspaceId = project.workspaceId;

    // 4. If no specific roles required, membership is sufficient
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    // 5. Workspace Admins/Owners bypass project level constraints
    if (isWorkspaceAdminOrOwner) {
      return true;
    }

    // 6. Check Project Role Hierarchy
    const memberRole = projectMember.role as ProjectRole;
    const memberLevel = ProjectRoleHierarchy[memberRole] || 0;

    const isAllowed = requiredRoles.some((role) => {
      const requiredLevel = ProjectRoleHierarchy[role as ProjectRole] || 0;
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
