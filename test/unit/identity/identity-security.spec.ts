import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from '@/modules/identity/auth';
import {
  ProjectAccessGuard as RoleGuard,
  Role,
} from '@/modules/project/access';
import { IDENTITY_REDIS_KEYS } from '@/modules/identity/core/constants/identity.constant';

describe('Identity Security Suite (BOLA Prevention & Real-time Revocation)', () => {
  describe('AuthGuard - Real-time Revocation & Query Token Restriction', () => {
    let authGuard: AuthGuard;
    let mockJwtService: { verifyAsync: jest.Mock };
    let mockConfigService: { get: jest.Mock };
    let mockReflector: { getAllAndOverride: jest.Mock };
    let mockRedis: any;

    beforeEach(() => {
      mockJwtService = {
        verifyAsync: jest.fn(),
      };
      mockConfigService = {
        get: jest.fn().mockReturnValue('test-jwt-secret'),
      };
      mockReflector = {
        getAllAndOverride: jest.fn().mockReturnValue(false),
      };
      mockRedis = {
        get: jest.fn().mockResolvedValue(null),
      };

      authGuard = new AuthGuard(
        mockJwtService as any,
        mockConfigService as any,
        mockReflector as any,
        mockRedis,
      );
    });

    it('should authenticate request with valid bearer token', async () => {
      mockJwtService.verifyAsync.mockResolvedValue({
        sub: 'valid-user-id',
        email: 'user@example.com',
      });

      const mockContext = {
        getHandler: () => ({}),
        getClass: () => ({}),
        switchToHttp: () => ({
          getRequest: () => ({
            headers: { authorization: 'Bearer valid-jwt-token' },
            query: {},
          }),
        }),
      } as unknown as ExecutionContext;

      const result = await authGuard.canActivate(mockContext);
      expect(result).toBe(true);
    });

    it('should reject when real-time revocation blacklist key is present in Redis', async () => {
      const tokenIatSeconds = 1000;
      const revokedAtMs = (tokenIatSeconds + 10) * 1000;

      mockJwtService.verifyAsync.mockResolvedValue({
        sub: 'revoked-user-id',
        email: 'user@example.com',
        iat: tokenIatSeconds,
      });
      mockRedis.get.mockImplementation((key: string) => {
        if (key === IDENTITY_REDIS_KEYS.revoked('revoked-user-id')) {
          return Promise.resolve(revokedAtMs);
        }
        return Promise.resolve(null);
      });

      const mockContext = {
        getHandler: () => ({}),
        getClass: () => ({}),
        switchToHttp: () => ({
          getRequest: () => ({
            headers: { authorization: 'Bearer revoked-jwt-token' },
            query: {},
          }),
        }),
      } as unknown as ExecutionContext;

      await expect(authGuard.canActivate(mockContext)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should forbid query parameter tokens on non-streaming routes', async () => {
      const mockContext = {
        getHandler: () => ({}),
        getClass: () => ({}),
        switchToHttp: () => ({
          getRequest: () => ({
            url: '/api/v1/projects',
            headers: {},
            query: { token: 'unauthorized-query-token' },
          }),
        }),
      } as unknown as ExecutionContext;

      await expect(authGuard.canActivate(mockContext)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should permit query parameter tokens exclusively on AI chat stream route', async () => {
      mockJwtService.verifyAsync.mockResolvedValue({
        sub: 'stream-user-id',
        email: 'user@example.com',
      });

      const mockContext = {
        getHandler: () => ({}),
        getClass: () => ({}),
        switchToHttp: () => ({
          getRequest: () => ({
            url: '/api/ai/chat/stream',
            headers: {},
            query: { token: 'valid-stream-token' },
          }),
        }),
      } as unknown as ExecutionContext;

      const result = await authGuard.canActivate(mockContext);
      expect(result).toBe(true);
    });
  });

  describe('RoleGuard - Anti-BOLA / Cross-tenant Protection', () => {
    let roleGuard: RoleGuard;
    let mockReflector: jest.Mocked<Partial<Reflector>>;
    let mockPrisma: any;
    let mockAccessService: any;

    beforeEach(() => {
      mockReflector = {
        getAllAndOverride: jest.fn().mockImplementation((key: string) => {
          if (key === 'roles') return [Role.OWNER, Role.CONTRIBUTOR];
          return undefined;
        }),
      };
      mockPrisma = {
        workItem: {
          findFirst: jest.fn(),
        },
        project: {
          findFirst: jest.fn(),
        },
      };
      mockAccessService = {
        getMemberAccessContext: jest.fn().mockResolvedValue({
          role: Role.CONTRIBUTOR,
          permissionOverrides: {},
          effectivePermissions: [],
        }),
        hasPermission: jest.fn().mockReturnValue(true),
        hasRole: jest.fn().mockReturnValue(true),
      };

      roleGuard = new RoleGuard(
        mockReflector as any,
        mockPrisma,
        mockAccessService,
      );
    });

    it('should detect BOLA attack when client provides mismatched x-project-id header for another project resource', async () => {
      const legitimateProjectId = 'a0000000-0000-4000-8000-000000000001';
      const attackerProjectId = 'b0000000-0000-4000-8000-000000000002';
      const targetWorkItemId = 'c0000000-0000-4000-8000-000000000003';

      // WorkItem belongs to legitimateProjectId
      mockPrisma.workItem.findFirst.mockResolvedValue({
        projectId: legitimateProjectId,
      });

      const mockContext = {
        getHandler: () => ({}),
        getClass: () => ({}),
        switchToHttp: () => ({
          getRequest: () => ({
            user: { sub: 'attacker-user-id' },
            params: { workItemId: targetWorkItemId },
            headers: { 'x-project-id': attackerProjectId }, // Attacker tries to impersonate project scope
          }),
        }),
      } as unknown as ExecutionContext;

      await expect(roleGuard.canActivate(mockContext)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should authorize access when child resource project matches verified project role', async () => {
      const legitimateProjectId = 'a0000000-0000-4000-8000-000000000001';
      const targetWorkItemId = 'c0000000-0000-4000-8000-000000000003';

      mockPrisma.workItem.findFirst.mockResolvedValue({
        projectId: legitimateProjectId,
      });
      mockPrisma.project.findFirst.mockResolvedValue({
        id: legitimateProjectId,
        createdById: 'legitimate-user-id',
      });

      const mockContext = {
        getHandler: () => ({}),
        getClass: () => ({}),
        switchToHttp: () => ({
          getRequest: () => ({
            user: { sub: 'legitimate-user-id' },
            params: { workItemId: targetWorkItemId },
          }),
        }),
      } as unknown as ExecutionContext;

      const result = await roleGuard.canActivate(mockContext);
      expect(result).toBe(true);
    });

    it('should throw ForbiddenException when projectId cannot be resolved from request', async () => {
      const mockContext = {
        getHandler: () => ({}),
        getClass: () => ({}),
        switchToHttp: () => ({
          getRequest: () => ({
            user: { sub: 'some-user-id' },
            params: {},
            headers: {},
            query: {},
            body: {},
          }),
        }),
      } as unknown as ExecutionContext;

      await expect(roleGuard.canActivate(mockContext)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });
});
