import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '@/core/database/prisma.service';
import { isUuid } from '@/core/utils/tenant.util';
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
    let explicitProjectId = request.params?.projectId;
    let claimedHeaderProjectId =
      request.headers?.['x-project-id'] || request.query?.projectId;

    let projectId: string | undefined = explicitProjectId;

    const hasSubResourceParam = Boolean(
      request.params?.cycleId ||
        request.params?.taskId ||
        request.params?.pageId ||
        request.params?.worklogId ||
        request.params?.commentId,
    );

    let subResourceProjectId: string | undefined;

    if (request.params?.cycleId && this.prisma.cycle?.findUnique) {
      const cycleId = request.params.cycleId;
      const cycle = isUuid(cycleId)
        ? await this.prisma.cycle
            .findUnique({
              where: { id: cycleId },
              select: { projectId: true },
            })
            .catch(() => null)
        : null;
      if (cycle?.projectId) {
        subResourceProjectId = cycle.projectId;
      }
    } else if (request.params?.taskId && this.prisma.task?.findUnique) {
      const taskId = request.params.taskId;
      const task = isUuid(taskId)
        ? await this.prisma.task
            .findUnique({
              where: { id: taskId },
              select: { projectId: true },
            })
            .catch(() => null)
        : null;
      if (task?.projectId) {
        subResourceProjectId = task.projectId;
      }
    } else if (request.params?.pageId && this.prisma.page?.findUnique) {
      const pageId = request.params.pageId;
      const page = isUuid(pageId)
        ? await this.prisma.page
            .findUnique({
              where: { id: pageId },
              select: { projectId: true },
            })
            .catch(() => null)
        : null;
      if (page?.projectId) {
        subResourceProjectId = page.projectId;
      }
    } else if (request.params?.worklogId && this.prisma.worklog?.findUnique) {
      const worklogId = request.params.worklogId;
      const wl = isUuid(worklogId)
        ? await this.prisma.worklog
            .findUnique({
              where: { id: worklogId },
              select: { task: { select: { projectId: true } } },
            })
            .catch(() => null)
        : null;
      if (wl?.task?.projectId) {
        subResourceProjectId = wl.task.projectId;
      }
    } else if (request.params?.commentId) {
      const commentId = request.params.commentId;
      if (isUuid(commentId)) {
        // Check task comment first
        if (this.prisma.taskComment?.findUnique) {
          const tc = await this.prisma.taskComment
            .findUnique({
              where: { id: commentId },
              select: { task: { select: { projectId: true } } },
            })
            .catch(() => null);
          if (tc?.task?.projectId) {
            subResourceProjectId = tc.task.projectId;
          }
        }
        // Check page comment if not found
        if (!subResourceProjectId && this.prisma.pageComment?.findUnique) {
          const pc = await this.prisma.pageComment
            .findUnique({
              where: { id: commentId },
              select: { page: { select: { projectId: true } } },
            })
            .catch(() => null);
          if (pc?.page?.projectId) {
            subResourceProjectId = pc.page.projectId;
          }
        }
      }
    }

    if (hasSubResourceParam) {
      if (!subResourceProjectId) {
        throw new ForbiddenException('Resource not found or access denied');
      }
      projectId = subResourceProjectId;
      if (claimedHeaderProjectId) {
        let canonicalClaimedId = claimedHeaderProjectId;
        if (!isUuid(claimedHeaderProjectId)) {
          const proj = await this.prisma.project
            .findFirst({
              where: {
                identifier: { equals: claimedHeaderProjectId, mode: 'insensitive' },
                deletedAt: null,
              },
              select: { id: true },
            })
            .catch(() => null);
          if (proj) canonicalClaimedId = proj.id;
        }
        if (canonicalClaimedId !== subResourceProjectId) {
          throw new ForbiddenException(
            'Project context mismatch with requested resource',
          );
        }
      }
    } else if (!projectId) {
      projectId = claimedHeaderProjectId;
    }

    // Fail-closed if project context cannot be resolved
    if (!projectId) {
      throw new ForbiddenException(
        'Project context is required for this operation',
      );
    }

    // 2. Fetch project
    let project: { id: string; workspaceId: string } | null = null;
    if (isUuid(projectId)) {
      project = await this.prisma.project
        .findUnique({
          where: { id: projectId },
          select: { id: true, workspaceId: true },
        })
        .catch(() => null);
    } else {
      if (this.prisma.project.findFirst) {
        project = await this.prisma.project
          .findFirst({
            where: {
              identifier: { equals: projectId, mode: 'insensitive' },
              deletedAt: null,
            },
            select: { id: true, workspaceId: true },
          })
          .catch(() => null);
      }
      if (!project && this.prisma.project.findUnique) {
        project = await this.prisma.project
          .findUnique({
            where: { id: projectId },
            select: { id: true, workspaceId: true },
          })
          .catch(() => null);
      }
    }

    if (!project) {
      throw new ForbiddenException('Project not found');
    }

    const canonicalProjectId = project.id;
    if (request.params) {
      request.params.projectId = canonicalProjectId;
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
      request.projectId = canonicalProjectId;
      request.workspaceId = project.workspaceId;
      request.projectRole = ProjectRole.ADMIN;
      return true;
    }

    // 4. Project Membership check
    const projectMember = await this.prisma.projectMember.findFirst({
      where: {
        projectId: canonicalProjectId,
        userId,
      },
    });

    if (!projectMember) {
      throw new ForbiddenException('You are not a member of this project');
    }

    request.project = project;
    request.projectId = canonicalProjectId;
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
