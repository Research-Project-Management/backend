import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { MemberAccessContext } from '../types/access.type';

/**
 * Injects the authenticated user's project member record.
 * Attached to request by ProjectAccessGuard.
 */
export const CurrentMember = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): any => {
    const request = ctx.switchToHttp().getRequest();
    return request.projectMember ?? null;
  },
);

/**
 * Injects the full MemberAccessContext (role, overrides, effectivePermissions).
 * Attached to request by ProjectAccessGuard.
 */
export const CurrentAccessContext = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): MemberAccessContext | null => {
    const request = ctx.switchToHttp().getRequest();
    return request.accessContext ?? null;
  },
);
