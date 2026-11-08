import { UnauthorizedException, BadRequestException } from '@nestjs/common';
import { ExecutionContext } from '@nestjs/common';
import { AuthGuard } from '@/modules/identity/auth/guards/auth.guard';
import { AuthService } from '@/modules/identity/auth/auth.service';
import { UserService } from '@/modules/identity/user/user.service';
import { IDENTITY_REDIS_KEYS } from '@/modules/identity/core/constants/identity.constant';
import { RefreshToken } from '@prisma/client';
import * as bcrypt from 'bcrypt';

describe('Enterprise Session Governance & Multi-Device Token Invalidation', () => {
  describe('AuthGuard - Per-Session Immediate Revocation via JWT SID', () => {
    let authGuard: AuthGuard;
    let mockJwtService: any;
    let mockConfigService: any;
    let mockReflector: any;
    let mockRedis: any;

    const currentSessionId = 'active-session-uuid-1111';
    const revokedSessionId = 'revoked-session-uuid-2222';
    const userId = 'user-uuid-9999';

    beforeEach(() => {
      mockJwtService = { verifyAsync: jest.fn() };
      mockConfigService = { get: jest.fn().mockReturnValue('test-secret') };
      mockReflector = { getAllAndOverride: jest.fn().mockReturnValue(false) };
      mockRedis = {
        get: jest.fn().mockImplementation((key: string) => {
          if (key === IDENTITY_REDIS_KEYS.revokedSession(revokedSessionId)) {
            return Promise.resolve(Date.now());
          }
          return Promise.resolve(null);
        }),
      };

      authGuard = new AuthGuard(
        mockJwtService,
        mockConfigService,
        mockReflector,
        mockRedis,
      );
    });

    it('should permit access token with valid unrevoked sessionId (sid)', async () => {
      mockJwtService.verifyAsync.mockResolvedValue({
        sub: userId,
        id: userId,
        sid: currentSessionId,
        email: 'user@flux.ac.vn',
      });

      const mockContext = {
        getHandler: () => ({}),
        getClass: () => ({}),
        switchToHttp: () => ({
          getRequest: () => ({
            headers: { authorization: 'Bearer valid-token-with-sid' },
            query: {},
          }),
        }),
      } as unknown as ExecutionContext;

      const allowed = await authGuard.canActivate(mockContext);
      expect(allowed).toBe(true);
      expect(mockRedis.get).toHaveBeenCalledWith(
        IDENTITY_REDIS_KEYS.revokedSession(currentSessionId),
      );
    });

    it('should immediately reject access token when its sessionId is revoked in Redis', async () => {
      mockJwtService.verifyAsync.mockResolvedValue({
        sub: userId,
        id: userId,
        sid: revokedSessionId,
        email: 'user@flux.ac.vn',
      });

      const mockContext = {
        getHandler: () => ({}),
        getClass: () => ({}),
        switchToHttp: () => ({
          getRequest: () => ({
            headers: { authorization: 'Bearer revoked-session-token' },
            query: {},
          }),
        }),
      } as unknown as ExecutionContext;

      await expect(authGuard.canActivate(mockContext)).rejects.toThrow(
        UnauthorizedException,
      );
      await expect(authGuard.canActivate(mockContext)).rejects.toThrow(
        'Session has been revoked or expired. Please log in again.',
      );
    });
  });

  describe('AuthService - Multi-Device Session Invalidation', () => {
    let authService: AuthService;
    let mockAuthnRepo: any;
    let mockRedis: any;
    let mockAuditService: any;

    const userId = 'user-uuid-1234';
    const currentSessionId = 'session-laptop-uuid';
    const phoneSessionId = 'session-phone-uuid';
    const tabletSessionId = 'session-tablet-uuid';

    beforeEach(() => {
      mockAuthnRepo = {
        findActiveSessionsByUser: jest.fn(),
        revokeOtherUserSessions: jest.fn(),
        revokeUserSession: jest.fn(),
        revokeAllUserTokens: jest.fn(),
      };
      mockRedis = {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue('OK'),
        del: jest.fn().mockResolvedValue(1),
      };
      mockAuditService = {
        record: jest.fn().mockResolvedValue(undefined),
      };

      authService = new AuthService(
        mockAuthnRepo,
        {} as any, // UserService
        {} as any, // JwtService
        {} as any, // ConfigService
        mockRedis, // RedisCacheService (slot 5)
        {} as any, // PrismaService
        mockAuditService, // AuditService (slot 7)
      );
    });

    it('should mark isCurrent correctly for caller session in getActiveSessions', async () => {
      const mockSessions: Partial<RefreshToken>[] = [
        {
          id: currentSessionId,
          userId,
          familyId: 'fam-1',
          userAgent: 'Chrome / Windows',
          ipAddress: '1.2.3.4',
          expiresAt: new Date(Date.now() + 100000),
          createdAt: new Date(),
        },
        {
          id: phoneSessionId,
          userId,
          familyId: 'fam-2',
          userAgent: 'Safari / iPhone',
          ipAddress: '5.6.7.8',
          expiresAt: new Date(Date.now() + 100000),
          createdAt: new Date(),
        },
      ];

      mockAuthnRepo.findActiveSessionsByUser.mockResolvedValue(mockSessions);

      const result = await authService.getActiveSessions(userId, currentSessionId);

      expect(result.length).toBe(2);
      const current = result.find((s) => s.id === currentSessionId);
      const other = result.find((s) => s.id === phoneSessionId);

      expect(current?.isCurrent).toBe(true);
      expect(other?.isCurrent).toBe(false);
    });

    it('should revoke all other sessions in DB and blacklist their sessionIds in Redis', async () => {
      mockAuthnRepo.revokeOtherUserSessions.mockResolvedValue([
        phoneSessionId,
        tabletSessionId,
      ]);

      const result = await authService.revokeAllOtherSessions(
        userId,
        currentSessionId,
      );

      expect(result.revokedCount).toBe(2);
      expect(mockAuthnRepo.revokeOtherUserSessions).toHaveBeenCalledWith(
        userId,
        currentSessionId,
      );

      // Verify Redis blacklist was populated for both revoked devices
      expect(mockRedis.set).toHaveBeenCalledWith(
        IDENTITY_REDIS_KEYS.revokedSession(phoneSessionId),
        expect.any(Number),
        3600,
      );
      expect(mockRedis.set).toHaveBeenCalledWith(
        IDENTITY_REDIS_KEYS.revokedSession(tabletSessionId),
        expect.any(Number),
        3600,
      );

      // Verify current device was NOT blacklisted
      expect(mockRedis.set).not.toHaveBeenCalledWith(
        IDENTITY_REDIS_KEYS.revokedSession(currentSessionId),
        expect.any(Number),
        3600,
      );

      // Verify audit record
      expect(mockAuditService.record).toHaveBeenCalled();
    });
  });

  describe('UserService - Nuclear Token Invalidation on Password Change & Account Deactivation', () => {
    let userService: UserService;
    let mockUserRepo: any;
    let mockAuditService: any;
    let mockRedis: any;

    const userId = 'user-uuid-secure';

    beforeEach(() => {
      mockUserRepo = {
        findById: jest.fn(),
        findOwnedProjects: jest.fn().mockResolvedValue([]),
        archiveProjects: jest.fn().mockResolvedValue(1),
        deactivateAccount: jest.fn().mockResolvedValue(undefined),
        updateUser: jest.fn().mockResolvedValue({}),
        revokeAllUserRefreshTokens: jest.fn().mockResolvedValue({ count: 3 }),
      };
      mockAuditService = {
        record: jest.fn().mockResolvedValue(undefined),
      };
      mockRedis = {
        set: jest.fn().mockResolvedValue('OK'),
      };

      userService = new UserService(mockUserRepo, mockAuditService, mockRedis);
    });

    it('should set global user revocation timestamp in Redis upon password change', async () => {
      const hashedOldPassword = await bcrypt.hash('OldSecurePassword123!', 10);
      mockUserRepo.findById.mockResolvedValue({
        id: userId,
        password: hashedOldPassword,
      });

      await userService.changePassword(userId, {
        currentPassword: 'OldSecurePassword123!',
        newPassword: 'NewSecurePassword456!',
      });

      expect(mockUserRepo.updateUser).toHaveBeenCalled();
      expect(mockUserRepo.revokeAllUserRefreshTokens).toHaveBeenCalledWith(userId);

      // Nuclear Redis Invalidation: Rejects all access tokens issued before now
      expect(mockRedis.set).toHaveBeenCalledWith(
        IDENTITY_REDIS_KEYS.revoked(userId),
        expect.any(Number),
        7 * 86400,
      );
    });

    it('should set global user revocation timestamp in Redis upon account deactivation (deleteMe)', async () => {
      mockUserRepo.findById.mockResolvedValue({
        id: userId,
        status: 'active',
      });

      const res = await userService.deleteMe(userId);

      expect(res.success).toBe(true);
      expect(mockUserRepo.deactivateAccount).toHaveBeenCalledWith(userId);

      expect(mockRedis.set).toHaveBeenCalledWith(
        IDENTITY_REDIS_KEYS.revoked(userId),
        expect.any(Number),
        7 * 86400,
      );
    });
  });
});
