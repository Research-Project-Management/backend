import {
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ProjectAccessGuard } from '@/modules/project/access/guards/project-access.guard';
import { Role } from '@/modules/project/access/enums/role.enum';
import { ProjectResourceResolver } from '@/modules/project/access/resolvers/project-resource.resolver';

describe('ProjectAccessGuard & SEC-01 Characterization', () => {
  let guard: ProjectAccessGuard;
  let mockReflector: jest.Mocked<Partial<Reflector>>;
  let mockPrisma: any;
  let mockAccessService: any;
  let mockResolver: { resolveAuthoritativeProjectId: jest.Mock };
  let mockConfigService: any;

  const projectAId = 'a0000000-0000-4000-8000-000000000001';
  const projectBId = 'b0000000-0000-4000-8000-000000000002';
  const pageAId = 'c0000000-0000-4000-8000-000000000003';
  const userAId = 'u0000000-0000-4000-8000-000000000001';
  const userBId = 'u0000000-0000-4000-8000-000000000002';

  beforeEach(() => {
    mockReflector = {
      getAllAndOverride: jest.fn().mockImplementation((key: string) => {
        if (key === 'roles') return [Role.CONTRIBUTOR];
        if (key === 'min_role') return Role.CONTRIBUTOR;
        if (key === 'no_project_context') return false;
        return undefined;
      }),
    };

    mockPrisma = {
      manuscriptDoc: {
        findUnique: jest.fn(),
      },
      project: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
      },
      workItem: {
        findFirst: jest.fn(),
      },
    };

    mockAccessService = {
      getMemberAccessContext: jest
        .fn()
        .mockImplementation(async (projId: string, uId: string) => {
          if (projId === projectAId && uId === userAId) {
            return {
              role: Role.CONTRIBUTOR,
              permissionOverrides: {},
              effectivePermissions: [],
            };
          }
          if (projId === projectBId && uId === userBId) {
            return {
              role: Role.CONTRIBUTOR,
              permissionOverrides: {},
              effectivePermissions: [],
            };
          }
          return null;
        }),
      hasRole: jest.fn().mockReturnValue(true),
      hasPermission: jest.fn().mockReturnValue(true),
    };

    mockResolver = {
      resolveAuthoritativeProjectId: jest.fn(),
    };

    mockConfigService = {
      enforcementMode: 'enforce',
      isOperator: jest.fn().mockReturnValue(false),
    };

    // When resolver is provided, guard uses it; otherwise fallback to prisma
    guard = new ProjectAccessGuard(
      mockReflector as any,
      mockPrisma,
      mockAccessService,
      mockResolver as any,
      mockConfigService,
    );
  });

  const createMockContext = (request: any): ExecutionContext =>
    ({
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    }) as unknown as ExecutionContext;

  describe('SEC-01 IDOR Probe: Pairing Foreign Resource with Owned Project Hint', () => {
    it('PROBE: should reject an attacker accessing Victim Page A while providing Attacker Project B in headers', async () => {
      // Mock resolver behavior (when S1 is wired):
      // The resource pageA belongs to projectA, but header claims projectB -> mismatch!
      if (mockResolver.resolveAuthoritativeProjectId) {
        mockResolver.resolveAuthoritativeProjectId.mockRejectedValue(
          new ForbiddenException({
            statusCode: 403,
            code: 'PROJECT_CONTEXT_MISMATCH',
            message:
              'Resource does not belong to the requested project context',
          }),
        );
      }

      const req = {
        user: { sub: userBId },
        params: { pageId: pageAId },
        headers: { 'x-project-id': projectBId },
        query: {},
        body: {},
      };

      await expect(guard.canActivate(createMockContext(req))).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('Legitimate Access Control Verification', () => {
    it('should permit authorized member accessing resource in their own project', async () => {
      if (mockResolver.resolveAuthoritativeProjectId) {
        mockResolver.resolveAuthoritativeProjectId.mockResolvedValue({
          projectId: projectAId,
          source: 'pageId',
        });
      }

      const req: Record<string, any> = {
        user: { sub: userAId },
        params: { pageId: pageAId },
        headers: { 'x-project-id': projectAId },
        query: {},
        body: {},
      };

      const result = await guard.canActivate(createMockContext(req));
      expect(result).toBe(true);
      expect(req['resolvedProjectId']).toBe(projectAId);
    });

    it('should reject non-member accessing project resource', async () => {
      if (mockResolver.resolveAuthoritativeProjectId) {
        mockResolver.resolveAuthoritativeProjectId.mockResolvedValue({
          projectId: projectAId,
          source: 'pageId',
        });
      }

      const req = {
        user: { sub: 'unrelated-user-id' },
        params: { pageId: pageAId },
        headers: {},
        query: {},
        body: {},
      };

      await expect(guard.canActivate(createMockContext(req))).rejects.toThrow(
        ForbiddenException,
      );
    });
  });
});
