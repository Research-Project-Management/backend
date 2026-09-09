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

    // 1. Resolve workspace identifier
    let explicitWorkspaceId = request.params?.workspaceId;
    if (explicitWorkspaceId === '_' || explicitWorkspaceId === 'global') {
      explicitWorkspaceId = undefined;
    }

    let claimedHeaderWorkspaceId =
      request.headers?.['x-workspace-id'] || request.query?.workspaceId;
    if (
      claimedHeaderWorkspaceId === '_' ||
      claimedHeaderWorkspaceId === 'global'
    ) {
      claimedHeaderWorkspaceId = undefined;
    }

    let workspaceId: string | undefined = explicitWorkspaceId;

    // Check if request targets an entity sub-resource
    const hasEntityParam = Boolean(
      request.params?.projectId ||
      request.params?.itemId ||
      request.params?.attachmentId ||
      request.params?.collectionId ||
      request.params?.tagId ||
      request.params?.labelId ||
      request.params?.fileId ||
      request.params?.pageId ||
      request.params?.taskId,
    );

    let entityWorkspaceId: string | undefined;

    // Resolve workspace from project if projectId is present
    if (request.params?.projectId && this.prisma?.project) {
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
        entityWorkspaceId = project.workspaceId;
      }
    }

    // Resolve workspace from catalogItem if itemId is present
    if (request.params?.itemId && this.prisma?.catalogItem) {
      const targetItemId = request.params.itemId;
      if (isUuid(targetItemId)) {
        const item = await this.prisma.catalogItem
          .findUnique({
            where: { id: targetItemId },
            select: { workspaceId: true },
          })
          .catch(() => null);
        if (item?.workspaceId) {
          entityWorkspaceId = item.workspaceId;
        }
      }
    }

    // Resolve workspace from attachment if attachmentId is present
    if (
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
        entityWorkspaceId = attachment.catalogItem.workspaceId;
      }
    }

    // Resolve workspace from collection if collectionId is present
    if (
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
        entityWorkspaceId = col.workspaceId;
      }
    }

    // Resolve workspace from tag if tagId is present
    if (
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
        entityWorkspaceId = tag.workspaceId;
      }
    }

    // Resolve workspace from label if labelId is present
    if (
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
        entityWorkspaceId = lbl.workspaceId;
      }
    }

    // Resolve workspace from file if fileId is present
    if (
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
        entityWorkspaceId = file.workspaceId;
      }
    }

    // Resolve workspace from page if pageId is present
    if (
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
        entityWorkspaceId = page.workspaceId;
      }
    }

    // Resolve workspace from task if taskId is present
    if (
      request.params?.taskId &&
      this.prisma?.task &&
      isUuid(request.params.taskId)
    ) {
      const task = await this.prisma.task
        .findUnique({
          where: { id: request.params.taskId },
          select: { project: { select: { workspaceId: true } } },
        })
        .catch(() => null);
      if (task?.project?.workspaceId) {
        entityWorkspaceId = task.project.workspaceId;
      }
    }

    if (hasEntityParam) {
      if (!entityWorkspaceId) {
        throw new ForbiddenException('Resource not found or access denied');
      }
      workspaceId = entityWorkspaceId;
      // If client also claimed a workspace header, verify consistency
      if (claimedHeaderWorkspaceId) {
        const claimedWs = await this.prisma.workspace
          .findFirst({
            where: buildWorkspaceIdentifierWhere(claimedHeaderWorkspaceId),
            select: { id: true },
          })
          .catch(() => null);
        if (claimedWs && claimedWs.id !== entityWorkspaceId) {
          throw new ForbiddenException(
            'Workspace context mismatch with requested resource',
          );
        }
      }
    } else if (!workspaceId) {
      workspaceId = claimedHeaderWorkspaceId;
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
