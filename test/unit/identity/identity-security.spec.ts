import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AuthGuard, AuthService } from '@/modules/identity/auth';
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
  describe('Token Rotation & Multi-Tab Concurrency Grace Window', () => {
    let authService: AuthService;
    let mockAuthRepo: any;
    let mockUserService: any;
    let mockJwtService: any;
    let mockConfigService: any;
    let mockRedis: any;
    let mockPrisma: any;
    let mockAuditService: any;

    beforeEach(() => {
      mockAuthRepo = {
        findRefreshToken: jest.fn(),
        rotateToken: jest.fn(),
        createSession: jest.fn(),
        revokeFamily: jest.fn(),
        revokeAllUserTokens: jest.fn(),
      };
      mockUserService = {};
      mockJwtService = {
        signAsync: jest.fn().mockResolvedValue('fresh-jwt-token'),
      };
      mockConfigService = {
        get: jest.fn((k: string) => {
          if (k === 'JWT_REFRESH_EXPIRATION') return '7d';
          return 'default-secret';
        }),
      };
      mockRedis = {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue('OK'),
        del: jest.fn().mockResolvedValue(1),
      };
      mockPrisma = {
        refreshToken: {
          findFirst: jest.fn(),
        },
      };
      mockAuditService = {
        record: jest.fn().mockResolvedValue(undefined),
      };

      authService = new AuthService(
        mockAuthRepo,
        mockUserService,
        mockJwtService,
        mockConfigService,
        mockRedis,
        mockPrisma,
        mockAuditService,
      );
    });

    it('should serve cached token refresh on fast-path Redis grace window hit', async () => {
      const cachedResponse = {
        accessToken: 'cached-access-token',
        refreshToken: 'cached-refresh-token',
        user: { id: 'u1', email: 'test@flux.study', name: 'Tester', avatar: null, status: 'active' },
      };
      mockRedis.get.mockResolvedValue(cachedResponse);

      const result = await authService.refresh('raw-token-123');

      expect(result).toEqual(cachedResponse);
      expect(mockAuthRepo.findRefreshToken).not.toHaveBeenCalled();
      expect(mockAuthRepo.rotateToken).not.toHaveBeenCalled();
    });

    it('should issue sibling tokens within 30-second database grace window for concurrent tabs', async () => {
      const revokedTokenRecord = {
        id: 'token-old-id',
        userId: 'u1',
        familyId: 'family-1',
        isRevoked: true,
        revokedAt: new Date(Date.now() - 5000),
        expiresAt: new Date(Date.now() + 86400000),
        user: { id: 'u1', email: 'test@flux.study', status: 'active', profile: { name: 'Tester', avatar: null } },
      };
      mockAuthRepo.findRefreshToken.mockResolvedValue(revokedTokenRecord);
      mockPrisma.refreshToken.findFirst.mockResolvedValue({
        id: 'child-token-id',
        userId: 'u1',
        familyId: 'family-1',
        user: revokedTokenRecord.user,
      });

      const result = await authService.refresh('raw-token-123');

      expect(result.accessToken).toBe('fresh-jwt-token');
      expect(mockAuthRepo.createSession).toHaveBeenCalled();
      expect(mockRedis.set).toHaveBeenCalledWith(
        expect.stringContaining('identity:grace:'),
        expect.any(Object),
        30,
      );
    });

    it('should terminate entire token family on breach replay attempt outside grace window (>30s)', async () => {
      const compromisedToken = {
        id: 'token-old-id',
        userId: 'u1',
        familyId: 'family-1',
        isRevoked: true,
        revokedAt: new Date(Date.now() - 45000),
        expiresAt: new Date(Date.now() + 86400000),
        user: { id: 'u1', email: 'test@flux.study', status: 'active' },
      };
      mockAuthRepo.findRefreshToken.mockResolvedValue(compromisedToken);

      await expect(authService.refresh('stolen-token-123')).rejects.toThrow(
        UnauthorizedException,
      );

      expect(mockAuthRepo.revokeFamily).toHaveBeenCalledWith('family-1');
      expect(mockAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'auth.token_breach_detected',
          severity: 'critical',
        }),
      );
    });

    it('should recover gracefully when rotateToken fails due to concurrency race', async () => {
      const activeToken = {
        id: 'token-racing-id',
        userId: 'u1',
        familyId: 'family-1',
        isRevoked: false,
        expiresAt: new Date(Date.now() + 86400000),
        user: { id: 'u1', email: 'test@flux.study', status: 'active', profile: { name: 'Tester', avatar: null } },
      };
      mockAuthRepo.findRefreshToken.mockResolvedValue(activeToken);
      mockAuthRepo.rotateToken.mockRejectedValue(new Error('Refresh token already used'));

      mockAuthRepo.findRefreshToken.mockResolvedValueOnce(activeToken).mockResolvedValueOnce({
        ...activeToken,
        revokedAt: new Date(),
        isRevoked: true,
      });
      mockPrisma.refreshToken.findFirst.mockResolvedValue({
        id: 'winner-child-id',
        userId: 'u1',
        familyId: 'family-1',
        user: activeToken.user,
      });

      const result = await authService.refresh('racing-token');

      expect(result.accessToken).toBe('fresh-jwt-token');
      expect(result.user.email).toBe('test@flux.study');
    });
  });
});
