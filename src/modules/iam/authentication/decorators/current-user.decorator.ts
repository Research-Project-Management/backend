import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthenticatedUser, JwtPayload } from '../../types/iam.types';

/**
 * Strongly-typed CurrentUser parameter decorator.
 * Extracts authenticated user or specific field from execution context.
 *
 * @example
 * ```ts
 * @Get('profile')
 * getProfile(@CurrentUser() user: AuthenticatedUser) { ... }
 *
 * @Get('id')
 * getId(@CurrentUser('sub') userId: UserId) { ... }
 * ```
 */
export const CurrentUser = createParamDecorator(
  (data: keyof JwtPayload | keyof AuthenticatedUser | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const user = request.user;
    if (!user) return null;
    return data ? user[data] : user;
  },
);
