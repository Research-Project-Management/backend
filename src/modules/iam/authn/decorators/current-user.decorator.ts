import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthenticatedUser, JwtPayload } from '../../types/iam.types';

/**
 * Strongly-typed CurrentUser parameter decorator.
 * Extracts authenticated user or specific field from execution context.
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
