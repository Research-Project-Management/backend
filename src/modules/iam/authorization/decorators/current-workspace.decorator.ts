import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { WorkspaceId } from '../../types/iam.types';

/**
 * Extracts verified WorkspaceId from request context (resolved by WorkspaceRoleGuard).
 */
export const CurrentWorkspace = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): WorkspaceId | null => {
    const request = ctx.switchToHttp().getRequest();
    return (request.workspaceId as WorkspaceId) || null;
  },
);
