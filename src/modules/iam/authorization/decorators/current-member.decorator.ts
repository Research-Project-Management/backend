import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * Extracts verified WorkspaceMember record from request context attached by WorkspaceRoleGuard.
 */
export const CurrentMember = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    return request.workspaceMember || null;
  },
);
