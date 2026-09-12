import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthenticatedUser, JwtPayload } from '../../core/types/iam.type';

/**
 * Injects authenticated user context from request.
 * Usage:
 *   @CurrentUser() user: AuthenticatedUser
 *   @CurrentUser('id') userId: string
 */
export const CurrentUser = createParamDecorator(
  (
    data: keyof JwtPayload | keyof AuthenticatedUser | undefined,
    ctx: ExecutionContext,
  ) => {
    const request = ctx.switchToHttp().getRequest();
    const user = request.user;
    if (!user) return null;
    if (data === 'id') {
      return user.id || user.sub || null;
    }
    return data ? user[data] : user;
  },
);

export const User = CurrentUser;
