import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export const CurrentMember = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    return request.workspaceMember || null;
  },
);
