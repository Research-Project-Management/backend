import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { CurrentMemberContext } from '../../core/types/iam.type';

/**
 * Injects the authenticated user's project member context.
 * Attached to request by RoleGuard / RolesGuard.
 *
 * Usage:
 *   @Get(':projectId/work-items')
 *   getWorkItems(@CurrentMember() member: CurrentMemberContext)
 */
export const CurrentMember = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): CurrentMemberContext | null => {
    const request = ctx.switchToHttp().getRequest();
    return request.projectMember ?? null;
  },
);
