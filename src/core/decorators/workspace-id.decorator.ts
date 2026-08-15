import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export const WorkspaceId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    return (
      request.params?.workspaceId ||
      request.params?.id ||
      request.headers?.['x-workspace-id']
    );
  },
);
