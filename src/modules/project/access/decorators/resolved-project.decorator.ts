import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * Injects the single authorized project id resolved and validated by ProjectAccessGuard.
 * Handlers must use this rather than reading from headers/query/body.
 */
export const ResolvedProject = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | null => {
    const request = ctx.switchToHttp().getRequest();
    return request.resolvedProjectId ?? request.projectId ?? null;
  },
);
