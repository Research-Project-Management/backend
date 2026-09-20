import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type {
  AuthenticatedUser,
  JwtPayload,
} from '../../core/types/identity.type';

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
    const request = ctx.switchToHttp().getRequest<{
      user?: (AuthenticatedUser & JwtPayload) | null;
    }>();
    const user = request.user;
    if (!user) return null;
    if (data === 'id') {
      return user.id || user.sub || null;
    }
    return data ? user[data as keyof typeof user] : user;
  },
);

export const User = CurrentUser;
