import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { fromPartial } from '@total-typescript/shoehorn';
import type { PrismaService, RedisCacheService } from '@/core';
import { AuditService } from '@/modules/identity/audit/audit.service';
import { AuthGuard, AuthService } from '@/modules/identity/auth';
import { AuthRepository } from '@/modules/identity/auth/auth.repository';
import { IDENTITY_REDIS_KEYS } from '@/modules/identity/core/constants/identity.constant';
import { UserService } from '@/modules/identity/user/user.service';

describe('Identity AuthGuard, Token Rotation Grace Window & Session Governance', () => {
  describe('AuthGuard - Real-time Global & SID Revocation + Query Token Restriction', () => {
    let authGuard: AuthGuard;
    let verifyAsync: jest.Mock;
    let redisGet: jest.Mock;

    const makeCtx = (req: Record<string, unknown>): ExecutionContext =>
      fromPartial<ExecutionContext>({
        getHandler: () => (() => undefined) as never,
        getClass: () => class Dummy {} as never,
        switchToHttp: () => ({ getRequest: () => req }),
      });

    beforeEach(() => {
      verifyAsync = jest.fn();
      redisGet = jest.fn().mockResolvedValue(null);
      authGuard = new AuthGuard(
        fromPartial<JwtService>({ verifyAsync }),
        fromPartial<ConfigService>({
          get: jest.fn().mockReturnValue('test-jwt-secret'),
        }),
        fromPartial<Reflector>({
          getAllAndOverride: jest.fn().mockReturnValue(false),
        }),
        fromPartial<RedisCacheService>({ get: redisGet }),
      );
    });

    it('authenticates valid Bearer tokens and enforces global iat revocation & per-session SID revocation', async () => {
      verifyAsync.mockResolvedValueOnce({
        sub: 'valid-user',
        sid: 'active-sid-1',
        email: 'user@example.com',
      });
      await expect(
        authGuard.canActivate(
          makeCtx({
            headers: { authorization: 'Bearer valid-jwt' },
            query: {},
          }),
        ),
      ).resolves.toBe(true);
      expect(redisGet).toHaveBeenCalledWith(
        IDENTITY_REDIS_KEYS.revokedSession('active-sid-1'),
      );

      // Global user revocation (revokedAtMs > iat * 1000)
      verifyAsync.mockResolvedValueOnce({
        sub: 'revoked-user',
        iat: 1000,
      });
      redisGet.mockImplementationOnce(async (key: string) =>
        key === IDENTITY_REDIS_KEYS.revoked('revoked-user')
          ? 1010 * 1000
          : null,
      );
      await expect(
        authGuard.canActivate(
          makeCtx({
            headers: { authorization: 'Bearer revoked-jwt' },
            query: {},
          }),
        ),
      ).rejects.toThrow(UnauthorizedException);

      // Per-session SID revocation
      verifyAsync.mockResolvedValueOnce({
        sub: 'user-1',
        sid: 'revoked-sid-2',
      });
      redisGet.mockImplementation(async (key: string) =>
        key === IDENTITY_REDIS_KEYS.revokedSession('revoked-sid-2')
          ? Date.now()
          : null,
      );
      await expect(
        authGuard.canActivate(
          makeCtx({
            headers: { authorization: 'Bearer sid-revoked-jwt' },
            query: {},
          }),
        ),
      ).rejects.toThrow(
        'Session has been revoked or expired. Please log in again.',
      );
    });

    it('forbids query-string tokens on non-streaming routes and permits them on /api/ai/chat/stream', async () => {
      await expect(
        authGuard.canActivate(
          makeCtx({
            url: '/api/v1/projects',
            headers: {},
            query: { token: 'query-token' },
          }),
        ),
      ).rejects.toThrow(UnauthorizedException);

      verifyAsync.mockResolvedValueOnce({
        sub: 'stream-user-id',
        email: 'user@example.com',
      });
      await expect(
        authGuard.canActivate(
          makeCtx({
            url: '/api/ai/chat/stream',
            headers: {},
            query: { token: 'valid-stream-token' },
          }),
        ),
      ).resolves.toBe(true);
    });
  });

  describe('AuthService - Token Rotation Grace Window, Breach Detection & Multi-Device Sessions', () => {
    let authService: AuthService;
    let mockAuthRepo: jest.Mocked<AuthRepository>;
    let mockRedis: jest.Mocked<RedisCacheService>;
    let mockRefreshTokenFindFirst: jest.Mock;
    let mockAudit: jest.Mocked<AuditService>;

    beforeEach(() => {
      mockAuthRepo = fromPartial<jest.Mocked<AuthRepository>>({
        findRefreshToken: jest.fn(),
        rotateToken: jest.fn(),
        createSession: jest.fn(),
        revokeFamily: jest.fn(),
        revokeAllUserTokens: jest.fn(),
        findActiveSessionsByUser: jest.fn(),
        revokeOtherUserSessions: jest.fn(),
      });
      mockRedis = fromPartial<jest.Mocked<RedisCacheService>>({
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue(undefined),
        del: jest.fn().mockResolvedValue(1),
      });
      mockRefreshTokenFindFirst = jest.fn();
      mockAudit = fromPartial<jest.Mocked<AuditService>>({
        record: jest.fn().mockResolvedValue(undefined),
      });

      authService = new AuthService(
        mockAuthRepo,
        fromPartial<UserService>({}),
        fromPartial<JwtService>({
          signAsync: jest.fn().mockResolvedValue('fresh-jwt-token'),
        }),
        fromPartial<ConfigService>({
          get: jest.fn((k: string) =>
            k === 'JWT_REFRESH_EXPIRATION' ? '7d' : 'default-secret',
          ),
        }),
        mockRedis,
        fromPartial<PrismaService>({
          refreshToken: { findFirst: mockRefreshTokenFindFirst },
        }),
        mockAudit,
      );
    });

    it('serves Redis grace hits, issues sibling tokens within 30s DB grace window, revokes family on >30s replay breach, and recovers from rotateToken race', async () => {
      // 1. Redis fast-path grace hit
      const cachedResponse = {
        accessToken: 'cached-access',
        refreshToken: 'cached-refresh',
        user: {
          id: 'u1',
          email: 'test@flux.study',
          name: 'Tester',
          avatar: null,
          status: 'active',
        },
      };
      mockRedis.get.mockResolvedValueOnce(cachedResponse as never);
      await expect(authService.refresh('raw-token-123')).resolves.toEqual(
        cachedResponse,
      );
      expect(mockAuthRepo.findRefreshToken).not.toHaveBeenCalled();

      // 2. Within 30s DB grace window (revoked 5s ago)
      const userObj = {
        id: 'u1',
        email: 'test@flux.study',
        status: 'active' as const,
        profile: { name: 'Tester', avatar: null },
      };
      mockAuthRepo.findRefreshToken.mockResolvedValueOnce(
        fromPartial({
          id: 'token-old-id',
          userId: 'u1',
          familyId: 'family-1',
          isRevoked: true,
          revokedAt: new Date(Date.now() - 5_000),
          expiresAt: new Date(Date.now() + 86_400_000),
          user: userObj,
        }),
      );
      mockRefreshTokenFindFirst.mockResolvedValueOnce({
        id: 'child-token-id',
        userId: 'u1',
        familyId: 'family-1',
        user: userObj,
      });

      const graced = await authService.refresh('raw-token-123');
      expect(graced.accessToken).toBe('fresh-jwt-token');
      expect(mockRedis.set).toHaveBeenCalledWith(
        expect.stringContaining('identity:grace:'),
        expect.any(Object),
        30,
      );

      // 3. Outside grace window (>30s) -> family breach revocation
      mockAuthRepo.findRefreshToken.mockResolvedValueOnce(
        fromPartial({
          id: 'token-compromised',
          userId: 'u1',
          familyId: 'family-1',
          isRevoked: true,
          revokedAt: new Date(Date.now() - 45_000),
          expiresAt: new Date(Date.now() + 86_400_000),
          user: userObj,
        }),
      );
      await expect(authService.refresh('stolen-token')).rejects.toThrow(
        UnauthorizedException,
      );
      expect(mockAuthRepo.revokeFamily).toHaveBeenCalledWith('family-1');
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'auth.token_breach_detected',
          severity: 'critical',
        }),
      );

      // 4. Concurrency race recovery on rotateToken
      const activeToken = {
        id: 'token-racing-id',
        userId: 'u1',
        familyId: 'family-1',
        isRevoked: false,
        expiresAt: new Date(Date.now() + 86_400_000),
        user: userObj,
      };
      mockAuthRepo.findRefreshToken
        .mockResolvedValueOnce(fromPartial(activeToken))
        .mockResolvedValueOnce(
          fromPartial({ ...activeToken, isRevoked: true, revokedAt: new Date() }),
        );
      mockAuthRepo.rotateToken.mockRejectedValueOnce(
        new Error('Refresh token already used'),
      );
      mockRefreshTokenFindFirst.mockResolvedValueOnce({
        id: 'winner-child-id',
        userId: 'u1',
        familyId: 'family-1',
        user: userObj,
      });

      const recovered = await authService.refresh('racing-token');
      expect(recovered.accessToken).toBe('fresh-jwt-token');
    });

    it('marks isCurrent on getActiveSessions and blacklists revoked device sessionIds in Redis without touching current session', async () => {
      const currentSid = 'session-laptop';
      const phoneSid = 'session-phone';
      const tabletSid = 'session-tablet';

      mockAuthRepo.findActiveSessionsByUser.mockResolvedValueOnce([
        fromPartial({
          id: currentSid,
          userId: 'u-1',
          familyId: 'fam-1',
          expiresAt: new Date(Date.now() + 100_000),
          createdAt: new Date(),
        }),
        fromPartial({
          id: phoneSid,
          userId: 'u-1',
          familyId: 'fam-2',
          expiresAt: new Date(Date.now() + 100_000),
          createdAt: new Date(),
        }),
      ]);

      const sessions = await authService.getActiveSessions('u-1', currentSid);
      expect(
        (sessions.find((s) => s.id === currentSid) as { isCurrent?: boolean })
          ?.isCurrent,
      ).toBe(true);
      expect(
        (sessions.find((s) => s.id === phoneSid) as { isCurrent?: boolean })
          ?.isCurrent,
      ).toBe(false);

      mockAuthRepo.revokeOtherUserSessions.mockResolvedValueOnce([
        phoneSid,
        tabletSid,
      ]);
      const res = await authService.revokeAllOtherSessions('u-1', currentSid);
      expect(res.revokedCount).toBe(2);
      expect(mockRedis.set).toHaveBeenCalledWith(
        IDENTITY_REDIS_KEYS.revokedSession(phoneSid),
        expect.any(Number),
        3600,
      );
      expect(mockRedis.set).toHaveBeenCalledWith(
        IDENTITY_REDIS_KEYS.revokedSession(tabletSid),
        expect.any(Number),
        3600,
      );
      expect(mockRedis.set).not.toHaveBeenCalledWith(
        IDENTITY_REDIS_KEYS.revokedSession(currentSid),
        expect.any(Number),
        3600,
      );
    });
  });
});
