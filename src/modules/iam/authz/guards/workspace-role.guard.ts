import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '@/core/database/prisma.service';
import {
  WORKSPACE_ROLES_KEY,
  WorkspaceRoleInput,
} from '../decorators/workspace-roles.decorator';
import {
  WorkspaceRole,
  WorkspaceRoleHierarchy,
} from '../enums/workspace-role.enum';

@Injectable()
export class WorkspaceRoleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.getAllAndOverride<
      WorkspaceRoleInput[]
    >(WORKSPACE_ROLES_KEY, [context.getHandler(), context.getClass()]);

    const request = context.switchToHttp().getRequest();
    const user = request.user;
    if (!user || (!user.sub && !user.id)) {
      throw new ForbiddenException('User is not authenticated');
    }

    const userId = user.sub || user.id;

    // 1. Resolve workspace identifier from various request parts
    let workspaceId =
      request.params?.workspaceId ||
      request.headers?.['x-workspace-id'] ||
      request.query?.workspaceId ||
      request.body?.workspaceId;

    // Direct /workspace/:id route param fallback
    if (
      !workspaceId &&
      request.params?.id &&
      !request.params?.projectId &&
      !request.params?.pageId &&
      !request.params?.taskId &&
      !request.params?.fileId
    ) {
      workspaceId = request.params.id;
    }

    // Resolve workspace from project if projectId is present
    if (!workspaceId && request.params?.projectId && this.prisma?.project) {
      const project = await this.prisma.project.findUnique({
        where: { id: request.params.projectId },
        select: { workspaceId: true },
      });
      if (project) {
        workspaceId = project.workspaceId;
      }
    }

    // Resolve workspace from attachment if attachmentId is present
    if (
      !workspaceId &&
      request.params?.attachmentId &&
      this.prisma?.catalogAttachment
    ) {
      const attachment = await this.prisma.catalogAttachment.findUnique({
        where: { id: request.params.attachmentId },
        select: { catalogItem: { select: { workspaceId: true } } },
      });
      if (attachment?.catalogItem?.workspaceId) {
        workspaceId = attachment.catalogItem.workspaceId;
      }
    }

    // Resolve workspace from file if fileId is present
    if (!workspaceId && request.params?.fileId && this.prisma?.file) {
      const file = await this.prisma.file.findUnique({
        where: { id: request.params.fileId },
        select: { workspaceId: true },
      });
      if (file?.workspaceId) {
        workspaceId = file.workspaceId;
      }
    }

    if (!workspaceId) {
      if (requiredRoles && requiredRoles.length > 0) {
        throw new ForbiddenException(
          'Workspace context is required for this operation',
        );
      }
      return true;
    }

    // 2. Fetch workspace to support UUID, slug, and URL
    const ws = await this.prisma.workspace.findFirst({
      where: {
        OR: [{ id: workspaceId }, { slug: workspaceId }, { url: workspaceId }],
        deletedAt: null,
      },
      select: { id: true },
    });
    const targetWsId = ws?.id || workspaceId;

    // 3. Check membership
    const member = await this.prisma.workspaceMember.findFirst({
      where: {
        workspaceId: targetWsId,
        userId,
      },
    });

    if (!member) {
      throw new ForbiddenException('You are not a member of this workspace');
    }

    request.workspaceMember = member;
    request.workspaceId = targetWsId;

    // 4. If no specific roles required, membership is sufficient
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    // 5. Evaluate role hierarchy
    const rawMemberRole = (member.role as string).toUpperCase();
    const memberRole = rawMemberRole as WorkspaceRole;
    const memberLevel = WorkspaceRoleHierarchy[memberRole] || 0;

    const isAllowed = requiredRoles.some((role) => {
      const normalized = role.toUpperCase() as WorkspaceRole;
      const requiredLevel = WorkspaceRoleHierarchy[normalized] || 0;
      return memberLevel >= requiredLevel;
    });

    if (!isAllowed) {
      throw new ForbiddenException(
        `Insufficient workspace permissions. Required: ${requiredRoles.join(', ')}`,
      );
    }

    return true;
  }
}
