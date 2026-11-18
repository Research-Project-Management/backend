import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * Injects the single authorized project/space id resolved and validated by ProjectAccessGuard.
 * Handlers must use this rather than reading from headers/query/body.
 */
export const ResolvedProject = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | null => {
    const request = ctx.switchToHttp().getRequest();
    return request.resolvedProjectId ?? request.projectId ?? null;
  },
);

/**
 * Canonical Space decorator injecting the authorized Space UUID (`user.id` for personal space,
 * `project.id` for project space) validated by ProjectAccessGuard.
 */
export const ResolvedSpace = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | null => {
    const request = ctx.switchToHttp().getRequest();
    return (
      request.resolvedSpaceId ??
      request.spaceId ??
      request.resolvedProjectId ??
      request.projectId ??
      null
    );
  },
);
