import {
  createParamDecorator,
  ExecutionContext,
  BadRequestException,
} from '@nestjs/common';

/**
 * Parameter decorator that extracts the tenant workspace ID from:
 * 1. request.params.workspaceId (Monolith multi-tenant route)
 * 2. request.headers['x-workspace-id'] (API Gateway / Microservice proxy header)
 * 3. request.workspaceId (resolved by WorkspaceRoleGuard)
 * 4. request.query.workspaceId (query parameter fallback)
 *
 * This allows controllers in the Library domain to operate identically
 * in both the modular monolith and as a standalone microservice (library-service).
 */
export const LibraryTenant = createParamDecorator(
  (options: { required?: boolean } | undefined, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest();
    const isRequired = options?.required ?? true;

    const workspaceId =
      request.params?.workspaceId ||
      request.headers?.['x-workspace-id'] ||
      request.workspaceId ||
      request.query?.workspaceId;

    if (isRequired && (!workspaceId || workspaceId === '_' || workspaceId === 'global')) {
      throw new BadRequestException(
        'Missing workspace context: please provide workspaceId in path or X-Workspace-Id header',
      );
    }

    return (workspaceId || '') as string;
  },
);
