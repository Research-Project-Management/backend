import {
  HttpException,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { fromPartial } from '@total-typescript/shoehorn';
import * as bcrypt from 'bcrypt';
import { PrismaService, RedisCacheService } from '@/core';
import { AuditService } from '@/modules/identity/audit/audit.service';
import { AUDIT_ACTIONS } from '@/modules/identity/audit/types/audit.type';
import { AuthRepository } from '@/modules/identity/auth/auth.repository';
import { AuthService } from '@/modules/identity/auth/auth.service';
import { UserService } from '@/modules/identity/user/user.service';

jest.mock('bcrypt', () => ({
  compare: jest.fn(),
  hash: jest.fn(),
}));

describe('AuthService - Anti-Brute-Force & Timing Attack Protections', () => {
  let authService: AuthService;
  let mockRepo: jest.Mocked<AuthRepository>;
  let mockRedis: jest.Mocked<RedisCacheService>;
  let mockAudit: jest.Mocked<AuditService>;

  const memoryStore = new Map<string, { value: unknown; ttl?: number }>();
  const mockedBcrypt = bcrypt as jest.Mocked<typeof bcrypt>;

  beforeEach(() => {
    memoryStore.clear();
    jest.clearAllMocks();

    mockRepo = fromPartial<jest.Mocked<AuthRepository>>({
      findUserByEmail: jest.fn(),
      findUserById: jest.fn(),
      updateUserPassword: jest.fn(),
      revokeAllUserTokens: jest.fn(),
      createSession: jest.fn(),
    });

    mockRedis = fromPartial<jest.Mocked<RedisCacheService>>({
      get: jest.fn(async (k: string) => (memoryStore.get(k)?.value as never) ?? null),
      set: jest.fn(async (k: string, v: unknown, ttl?: number) => {
        memoryStore.set(k, { value: v, ttl });
      }),
      del: jest.fn(async (k: string) => {
        memoryStore.delete(k);
        return 1;
      }),
      incr: jest.fn(async (k: string) => {
        const curr = (Number(memoryStore.get(k)?.value) || 0) + 1;
        memoryStore.set(k, { value: curr });
        return curr;
      }),
      expire: jest.fn().mockResolvedValue(true),
      ttl: jest.fn(async (k: string) => {
        const item = memoryStore.get(k);
        return item?.ttl && item.ttl > 0 ? item.ttl : -2;
      }),
    });

    mockAudit = fromPartial<jest.Mocked<AuditService>>({
      record: jest.fn().mockResolvedValue(undefined),
    });

    authService = new AuthService(
      mockRepo,
      fromPartial<UserService>({}),
      fromPartial<JwtService>({
        signAsync: jest.fn().mockResolvedValue('mock-token'),
      }),
      fromPartial<ConfigService>({
        get: jest.fn().mockReturnValue('mock-secret'),
      }),
      mockRedis,
      fromPartial<PrismaService>({}),
      mockAudit,
    );
  });

  describe('Constant-Time Dummy Comparison (User Enumeration Protection)', () => {
    it('executes dummy bcrypt comparison when user does not exist or has no password (OAuth-only)', async () => {
      mockRepo.findUserByEmail.mockResolvedValueOnce(null);
      mockedBcrypt.compare.mockResolvedValue(false as never);

      await expect(
        authService.login({
          email: 'ghost@flux.ai',
          password: 'WrongPassword123',
        }),
      ).rejects.toThrow(UnauthorizedException);
      expect(mockedBcrypt.compare).toHaveBeenCalledWith(
        'WrongPassword123',
        AuthService.DUMMY_BCRYPT_HASH,
      );

      mockedBcrypt.compare.mockClear();
      mockRepo.findUserByEmail.mockResolvedValueOnce(
        fromPartial({ id: 'user-oauth', email: 'oauth@flux.ai', password: null }),
      );
      await expect(
        authService.login({ email: 'oauth@flux.ai', password: 'AnyPassword' }),
      ).rejects.toThrow(UnauthorizedException);
      expect(mockedBcrypt.compare).toHaveBeenCalledWith(
        'AnyPassword',
        AuthService.DUMMY_BCRYPT_HASH,
      );
    });
  });

  describe('Adaptive Account Lockout & Reset Clearing', () => {
    it('locks account after 5 failed attempts and pre-emptively rejects 6th attempt without DB or bcrypt work', async () => {
      const targetEmail = 'researcher@flux.ai';
      mockRepo.findUserByEmail.mockResolvedValue(
        fromPartial({
          id: 'user-123',
          email: targetEmail,
          password: '$2b$10$hashedpassword',
          status: 'active',
        }),
      );
      mockedBcrypt.compare.mockResolvedValue(false as never);

      for (let i = 1; i <= 5; i++) {
        await expect(
          authService.login({ email: targetEmail, password: 'BadPassword' }),
        ).rejects.toThrow(UnauthorizedException);
      }

      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AUDIT_ACTIONS.AUTH_ACCOUNT_LOCKED,
          targetId: 'user-123',
        }),
      );
      expect(memoryStore.get(`identity:auth:locked:${targetEmail}`)?.ttl).toBe(
        900,
      );

      // Pre-emptive rejection on locked account
      mockRepo.findUserByEmail.mockClear();
      mockedBcrypt.compare.mockClear();
      await authService.lockAccount('locked@flux.ai', 600);

      let error: unknown;
      try {
        await authService.login({
          email: 'locked@flux.ai',
          password: 'AnyPassword',
        });
      } catch (err) {
        error = err;
      }

      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(
        HttpStatus.TOO_MANY_REQUESTS,
      );
      expect((error as HttpException).getResponse()).toMatchObject({
        code: 'ACCOUNT_TEMPORARILY_LOCKED',
        retryAfter: 600,
      });
      expect(mockRepo.findUserByEmail).not.toHaveBeenCalled();
      expect(mockedBcrypt.compare).not.toHaveBeenCalled();
    });

    it('clears failed login counters and lockouts upon valid login or password reset', async () => {
      const email = 'user@flux.ai';
      mockRepo.findUserByEmail.mockResolvedValue(
        fromPartial({
          id: 'user-789',
          email,
          password: '$2b$10$validhash',
          status: 'active',
          profile: { name: 'Valid User' },
        }),
      );

      await authService.recordFailedLogin(email);
      await authService.recordFailedLogin(email);
      expect(memoryStore.get(`identity:auth:fails:${email}`)?.value).toBe(2);

      mockedBcrypt.compare.mockResolvedValue(true as never);
      mockRepo.createSession.mockResolvedValue(fromPartial({ id: 'sess-1' }));

      await authService.login({ email, password: 'CorrectPassword' });
      expect(memoryStore.has(`identity:auth:fails:${email}`)).toBe(false);

      // Password reset clears lockout + fails
      const resetEmail = 'forgotten@flux.ai';
      const token = 'valid-crypto-reset-token';
      await authService.lockAccount(resetEmail, 900);
      await authService.recordFailedLogin(resetEmail);
      memoryStore.set(`identity:reset:${token}`, {
        value: { userId: 'user-reset-456' },
      });
      mockRepo.findUserById.mockResolvedValue(
        fromPartial({ id: 'user-reset-456', email: resetEmail }),
      );
      mockedBcrypt.hash.mockResolvedValue('$2b$10$newhashedpassword' as never);

      await authService.resetPassword(token, 'BrandNewPassword123!');
      expect(memoryStore.has(`identity:auth:locked:${resetEmail}`)).toBe(false);
      expect(memoryStore.has(`identity:auth:fails:${resetEmail}`)).toBe(false);
    });
  });
});
