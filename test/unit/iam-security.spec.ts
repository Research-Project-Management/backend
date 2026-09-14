import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from '@/modules/iam/authn/guards/auth.guard';
import { RoleGuard } from '@/modules/iam/authz/guards/role.guard';
import { Role } from '@/modules/iam/authz/enums/role.enum';
import { IAM_REDIS_KEYS } from '@/modules/iam/core/constants/redis.constant';

describe('IAM Security Suite (BOLA Prevention & Real-time Revocation)', () => {
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

    it('should grant access to valid, unrevoked JWT token', async () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      mockJwtService.verifyAsync.mockResolvedValue({
        sub: 'user-123',
        iat: nowSeconds,
      });

      const mockContext = {
        getHandler: () => ({}),
        getClass: () => ({}),
        switchToHttp: () => ({
          getRequest: () => ({
            headers: { authorization: 'Bearer valid-token' },
          }),
        }),
      } as unknown as ExecutionContext;

      const result = await authGuard.canActivate(mockContext);
      expect(result).toBe(true);
    });

    it('should reject JWT token when user has a recent revocation timestamp in Redis', async () => {
      const tokenIatSeconds = 1000;
      const revokedAtMs = (tokenIatSeconds + 10) * 1000; // Revoked after token issuance

      mockJwtService.verifyAsync.mockResolvedValue({
        sub: 'user-123',
        iat: tokenIatSeconds,
      });
      mockRedis.get.mockImplementation((key: string) => {
        if (key === IAM_REDIS_KEYS.revoked('user-123')) {
          return Promise.resolve(revokedAtMs);
        }
        return Promise.resolve(null);
      });

      const mockContext = {
        getHandler: () => ({}),
        getClass: () => ({}),
        switchToHttp: () => ({
          getRequest: () => ({
            headers: { authorization: 'Bearer revoked-token' },
          }),
        }),
      } as unknown as ExecutionContext;

      await expect(authGuard.canActivate(mockContext)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should reject ?token= query parameter on standard REST endpoints', async () => {
      const mockContext = {
        getHandler: () => ({}),
        getClass: () => ({}),
        switchToHttp: () => ({
          getRequest: () => ({
            url: '/api/v1/work-items',
            headers: {},
            query: { token: 'leaked-query-token' },
          }),
        }),
      } as unknown as ExecutionContext;

      await expect(authGuard.canActivate(mockContext)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should allow ?token= query parameter on streaming / SSE endpoints', async () => {
      mockJwtService.verifyAsync.mockResolvedValue({
        sub: 'user-123',
        iat: Math.floor(Date.now() / 1000),
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
    let mockRedis: any;

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
        projectMember: {
          findUnique: jest.fn(),
        },
      };
      mockRedis = {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue(undefined),
      };

      roleGuard = new RoleGuard(mockReflector as any, mockPrisma, mockRedis);
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
  });
});
