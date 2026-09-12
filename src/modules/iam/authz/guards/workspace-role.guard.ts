import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '@/core/database/prisma.service';
import { buildWorkspaceIdentifierWhere } from '@/core/utils/tenant.util';
import {
  WORKSPACE_ROLES_KEY,
} from '../decorators/workspace-roles.decorator';

/**
 * WorkspaceRoleGuard â€” Personal Workspace Model
 *
 * In the new architecture, each workspace is personal (1-to-1 with User).
 * This guard verifies that the requesting user is the owner of the workspace
 * identified in the request (via route param, header, or query).
 *
 * There are no workspace-level member roles. If you need to check project-level
 * access, use ProjectRoleGuard instead.
 */
@Injectable()
export class WorkspaceRoleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // If no roles required on the handler, just verify workspace ownership
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(
      WORKSPACE_ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user || (!user.sub && !user.id)) {
      throw new ForbiddenException('User is not authenticated');
    }

    const userId = user.sub || user.id;

    // 1. Resolve workspace identifier from route param, header, or query
    const workspaceIdentifier =
      request.params?.workspaceId ||
      request.headers?.['x-workspace-id'] ||
      request.query?.workspaceId;

    if (!workspaceIdentifier || workspaceIdentifier === '_' || workspaceIdentifier === 'global') {
      // No workspace context required â€” let pass (workspace resolved later by service)
      request.userId = userId;
      return true;
    }

    // 2. Fetch workspace by id, slug, or url
    const workspace = await this.prisma.workspace.findFirst({
      where: buildWorkspaceIdentifierWhere(workspaceIdentifier),
      select: { id: true, ownerId: true },
    });

    if (!workspace) {
      throw new ForbiddenException('Workspace not found');
    }

    // 3. Verify ownership: user must be the personal workspace owner
    if (workspace.ownerId !== userId) {
      throw new ForbiddenException(
        'Access denied: you are not the owner of this workspace',
      );
    }

    // 4. Attach resolved workspace context to request
    request.workspaceId = workspace.id;
    request.userId = userId;
    if (request.params) {
      request.params.workspaceId = workspace.id;
    }

    return true;
  }
}
