import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '@/core/database/prisma.service';
import {
  buildWorkspaceIdentifierWhere,
  isUuid,
} from '@/core/utils/tenant.util';
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

    // 1. Resolve workspace identifier from trusted request parts
    let workspaceId =
      request.params?.workspaceId ||
      request.headers?.['x-workspace-id'] ||
      request.query?.workspaceId;

    if (workspaceId === '_' || workspaceId === 'global') {
      workspaceId = undefined;
    }

    // Resolve workspace from project if projectId is present
    if (!workspaceId && request.params?.projectId && this.prisma?.project) {
      const projectId = request.params.projectId;
      const project = isUuid(projectId)
        ? await this.prisma.project
            .findUnique({
              where: { id: projectId },
              select: { workspaceId: true },
            })
            .catch(() => null)
        : await this.prisma.project
            .findFirst?.({
              where: {
                identifier: { equals: projectId, mode: 'insensitive' },
                deletedAt: null,
              },
              select: { workspaceId: true },
            })
            .catch(() => null);
      if (project?.workspaceId) {
        workspaceId = project.workspaceId;
      }
    }

    // Resolve workspace from catalogItem if itemId is present
    if (!workspaceId && request.params?.itemId && this.prisma?.catalogItem) {
      const targetItemId = request.params.itemId;
      if (isUuid(targetItemId)) {
        const item = await this.prisma.catalogItem
          .findUnique({
            where: { id: targetItemId },
            select: { workspaceId: true },
          })
          .catch(() => null);
        if (item?.workspaceId) {
          workspaceId = item.workspaceId;
        }
      }
    }

    // Resolve workspace from attachment if attachmentId is present
    if (
      !workspaceId &&
      request.params?.attachmentId &&
      this.prisma?.catalogAttachment &&
      isUuid(request.params.attachmentId)
    ) {
      const attachment = await this.prisma.catalogAttachment
        .findUnique({
          where: { id: request.params.attachmentId },
          select: { catalogItem: { select: { workspaceId: true } } },
        })
        .catch(() => null);
      if (attachment?.catalogItem?.workspaceId) {
        workspaceId = attachment.catalogItem.workspaceId;
      }
    }

    // Resolve workspace from collection if collectionId is present
    if (
      !workspaceId &&
      request.params?.collectionId &&
      this.prisma?.collection &&
      isUuid(request.params.collectionId)
    ) {
      const col = await this.prisma.collection
        .findUnique({
          where: { id: request.params.collectionId },
          select: { workspaceId: true },
        })
        .catch(() => null);
      if (col?.workspaceId) {
        workspaceId = col.workspaceId;
      }
    }

    // Resolve workspace from tag if tagId is present
    if (
      !workspaceId &&
      request.params?.tagId &&
      this.prisma?.catalogTag &&
      isUuid(request.params.tagId)
    ) {
      const tag = await this.prisma.catalogTag
        .findUnique({
          where: { id: request.params.tagId },
          select: { workspaceId: true },
        })
        .catch(() => null);
      if (tag?.workspaceId) {
        workspaceId = tag.workspaceId;
      }
    }

    // Resolve workspace from label if labelId is present
    if (
      !workspaceId &&
      request.params?.labelId &&
      this.prisma?.label &&
      isUuid(request.params.labelId)
    ) {
      const lbl = await this.prisma.label
        .findUnique({
          where: { id: request.params.labelId },
          select: { workspaceId: true },
        })
        .catch(() => null);
      if (lbl?.workspaceId) {
        workspaceId = lbl.workspaceId;
      }
    }

    // Resolve workspace from file if fileId is present
    if (
      !workspaceId &&
      request.params?.fileId &&
      this.prisma?.file &&
      isUuid(request.params.fileId)
    ) {
      const file = await this.prisma.file
        .findUnique({
          where: { id: request.params.fileId },
          select: { workspaceId: true },
        })
        .catch(() => null);
      if (file?.workspaceId) {
        workspaceId = file.workspaceId;
      }
    }

    // Resolve workspace from page if pageId is present
    if (
      !workspaceId &&
      request.params?.pageId &&
      this.prisma?.page &&
      isUuid(request.params.pageId)
    ) {
      const page = await this.prisma.page
        .findUnique({
          where: { id: request.params.pageId },
          select: { workspaceId: true },
        })
        .catch(() => null);
      if (page?.workspaceId) {
        workspaceId = page.workspaceId;
      }
    }

    // Resolve workspace from task if taskId is present
    if (
      !workspaceId &&
      (request.params?.taskId || request.params?.id) &&
      this.prisma?.task
    ) {
      const taskId = request.params.taskId || request.params.id;
      if (isUuid(taskId)) {
        const task = await this.prisma.task
          .findUnique({
            where: { id: taskId },
            select: { project: { select: { workspaceId: true } } },
          })
          .catch(() => null);
        if (task?.project?.workspaceId) {
          workspaceId = task.project.workspaceId;
        }
      }
    }

    // Fallback: If no explicit workspace identifier in route, resolve user's active/primary workspace
    if (!workspaceId && userId && this.prisma?.workspaceMember) {
      const activeWorkspaceMembership = await this.prisma.workspaceMember
        .findFirst({
          where: { userId },
          select: { workspaceId: true },
          orderBy: { joinedAt: 'desc' },
        })
        .catch(() => null);
      if (activeWorkspaceMembership?.workspaceId) {
        workspaceId = activeWorkspaceMembership.workspaceId;
      }
    }

    // Fail-closed if workspace context cannot be resolved
    if (!workspaceId) {
      throw new ForbiddenException(
        'Workspace context is required for this operation',
      );
    }

    if (typeof workspaceId !== 'string') {
      throw new ForbiddenException('Invalid workspace context');
    }

    // 2. Fetch workspace to support UUID, slug, and URL
    const ws = await this.prisma.workspace.findFirst({
      where: buildWorkspaceIdentifierWhere(workspaceId),
      select: { id: true, createdById: true },
    });
    if (!ws) {
      throw new ForbiddenException('You are not a member of this workspace');
    }
    const canonicalWorkspaceId = ws.id;

    // 3. Check membership
    let member = await this.prisma.workspaceMember.findFirst({
      where: {
        workspaceId: canonicalWorkspaceId,
        userId,
      },
    });

    if (!member) {
      // 3.1. Auto-restore/ensure owner membership for workspace creator
      if (ws?.createdById === userId) {
        member = await this.prisma.workspaceMember
          .upsert({
            where: {
              workspaceId_userId: {
                workspaceId: canonicalWorkspaceId,
                userId,
              },
            },
            update: { role: 'owner' },
            create: {
              workspaceId: canonicalWorkspaceId,
              userId,
              role: 'owner',
            },
          })
          .catch(() => null);
      }
    }

    if (!member) {
      throw new ForbiddenException('You are not a member of this workspace');
    }

    request.workspaceMember = member;
    request.workspaceId = canonicalWorkspaceId;
    if (!request.params) {
      request.params = {};
    }
    request.params.workspaceId = canonicalWorkspaceId;
    if (request.query && request.query.workspaceId) {
      request.query.workspaceId = canonicalWorkspaceId;
    }

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
