import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '@/core/database/prisma.service';
import { ROLES_KEY } from '../decorators/roles.decorator';

@Injectable()
export class WorkspaceRoleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    const request = context.switchToHttp().getRequest();
    const user = request.user;
    if (!user || (!user.sub && !user.id)) {
      throw new ForbiddenException('User is not authenticated');
    }

    const userId = user.sub || user.id;
    let workspaceId =
      request.params?.workspaceId ||
      request.headers?.['x-workspace-id'] ||
      (request.params?.id &&
      !request.params?.projectId &&
      !request.params?.pageId &&
      !request.params?.taskId &&
      !request.params?.fileId
        ? request.params.id
        : undefined);

    if (!workspaceId && request.params?.projectId && this.prisma?.project) {
      const project = await this.prisma.project.findUnique({
        where: { id: request.params.projectId },
        select: { workspaceId: true },
      });
      if (project) {
        workspaceId = project.workspaceId;
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

    const member = await this.prisma.workspaceMember.findFirst({
      where: {
        workspaceId,
        userId,
      },
    });

    if (!member) {
      throw new ForbiddenException('You are not a member of this workspace');
    }

    request.workspaceMember = member;

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const roleHierarchy: Record<string, number> = {
      viewer: 1,
      member: 2,
      admin: 3,
      owner: 4,
    };

    const memberLevel = roleHierarchy[member.role] || 0;
    const isAllowed = requiredRoles.some((role) => {
      const requiredLevel = roleHierarchy[role] || 0;
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
