import { HttpException, HttpStatus, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AuthService } from '../../../src/modules/identity/auth/auth.service';
import { AuthRepository } from '../../../src/modules/identity/auth/auth.repository';
import { UserService } from '../../../src/modules/identity/user/user.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { RedisCacheService, PrismaService } from '../../../src/core';
import { AuditService } from '../../../src/modules/identity/audit/audit.service';
import { AUDIT_ACTIONS } from '../../../src/modules/identity/audit/types/audit.type';

jest.mock('bcrypt', () => ({
  compare: jest.fn(),
  hash: jest.fn(),
}));

describe('AuthService - Anti-Brute-Force & Timing Attack Protections', () => {
  let authService: AuthService;
  let mockRepo: jest.Mocked<AuthRepository>;
  let mockUserService: jest.Mocked<UserService>;
  let mockJwtService: jest.Mocked<JwtService>;
  let mockConfigService: jest.Mocked<ConfigService>;
  let mockRedis: jest.Mocked<RedisCacheService>;
  let mockPrisma: jest.Mocked<PrismaService>;
  let mockAudit: jest.Mocked<AuditService>;

  const memoryStore = new Map<string, { value: any; ttl?: number }>();
  const mockedBcrypt = bcrypt as jest.Mocked<typeof bcrypt>;

  beforeEach(() => {
    memoryStore.clear();
    jest.clearAllMocks();

    mockRepo = {
      findUserByEmail: jest.fn(),
      findUserById: jest.fn(),
      updateUserPassword: jest.fn(),
      revokeAllUserTokens: jest.fn(),
      createSession: jest.fn(),
    } as any;

    mockUserService = {} as any;
    mockJwtService = {
      signAsync: jest.fn().mockResolvedValue('mock-token'),
    } as any;
    mockConfigService = {
      get: jest.fn().mockReturnValue('mock-secret'),
    } as any;

    mockRedis = {
      get: jest.fn().mockImplementation((k: string) => Promise.resolve(memoryStore.get(k)?.value ?? null)),
      set: jest.fn().mockImplementation((k: string, v: any, ttl?: number) => {
        memoryStore.set(k, { value: v, ttl });
        return Promise.resolve();
      }),
      del: jest.fn().mockImplementation((k: string) => {
        memoryStore.delete(k);
        return Promise.resolve();
      }),
      incr: jest.fn().mockImplementation((k: string) => {
        const curr = (Number(memoryStore.get(k)?.value) || 0) + 1;
        memoryStore.set(k, { value: curr });
        return Promise.resolve(curr);
      }),
      expire: jest.fn().mockResolvedValue(undefined),
      ttl: jest.fn().mockImplementation((k: string) => {
        const item = memoryStore.get(k);
        return Promise.resolve(item?.ttl && item.ttl > 0 ? item.ttl : -2);
      }),
    } as any;

    mockPrisma = {} as any;
    mockAudit = {
      record: jest.fn().mockResolvedValue(undefined),
    } as any;

    authService = new AuthService(
      mockRepo,
      mockUserService,
      mockJwtService,
      mockConfigService,
      mockRedis,
      mockPrisma,
      mockAudit,
    );
  });

  describe('Constant-Time Dummy Comparison (User Enumeration Protection)', () => {
    it('executes dummy bcrypt comparison when user does not exist', async () => {
      mockRepo.findUserByEmail.mockResolvedValue(null);
      mockedBcrypt.compare.mockResolvedValue(false as never);

      await expect(
        authService.login({ email: 'ghost@flux.ai', password: 'WrongPassword123' }),
      ).rejects.toThrow(UnauthorizedException);

      // Verify bcrypt was invoked with the precomputed dummy hash
      expect(mockedBcrypt.compare).toHaveBeenCalledWith(
        'WrongPassword123',
        AuthService.DUMMY_BCRYPT_HASH,
      );
    });

    it('executes dummy bcrypt comparison when user has no password (e.g. OAuth-only account)', async () => {
      mockRepo.findUserByEmail.mockResolvedValue({
        id: 'user-oauth',
        email: 'oauth@flux.ai',
        password: null,
      } as any);

      mockedBcrypt.compare.mockResolvedValue(false as never);

      await expect(
        authService.login({ email: 'oauth@flux.ai', password: 'AnyPassword' }),
      ).rejects.toThrow(UnauthorizedException);

      expect(mockedBcrypt.compare).toHaveBeenCalledWith(
        'AnyPassword',
        AuthService.DUMMY_BCRYPT_HASH,
      );
    });
  });

  describe('Adaptive Account Lockout (Anti-Brute-Force & Bcrypt DoS Protection)', () => {
    it('locks account after 5 consecutive failed login attempts', async () => {
      const targetEmail = 'researcher@flux.ai';
      const mockUser = {
        id: 'user-123',
        email: targetEmail,
        password: '$2b$10$hashedpassword',
        status: 'active',
      };
      mockRepo.findUserByEmail.mockResolvedValue(mockUser as any);
      mockedBcrypt.compare.mockResolvedValue(false as never);

      // 4 failed attempts
      for (let i = 1; i <= 4; i++) {
        await expect(
          authService.login({ email: targetEmail, password: 'BadPassword' }),
        ).rejects.toThrow(UnauthorizedException);
      }

      // 5th failed attempt: triggers lockout
      await expect(
        authService.login({ email: targetEmail, password: 'BadPassword' }),
      ).rejects.toThrow(UnauthorizedException);

      // Verify audit logged critical lockout
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AUDIT_ACTIONS.AUTH_ACCOUNT_LOCKED,
          targetId: 'user-123',
        }),
      );

      // Verify Redis lock is set with 900 seconds TTL
      const lockKey = `identity:auth:locked:${targetEmail}`;
      expect(memoryStore.has(lockKey)).toBe(true);
      expect(memoryStore.get(lockKey)?.ttl).toBe(900);
    });

    it('rejects pre-emptively on 6th attempt without querying database or running bcrypt (Bcrypt DoS Protection)', async () => {
      const targetEmail = 'locked@flux.ai';

      // Pre-set lockout in Redis
      await authService.lockAccount(targetEmail, 600);

      let error: any;
      try {
        await authService.login({ email: targetEmail, password: 'AnyPassword' });
      } catch (err) {
        error = err;
      }

      expect(error).toBeInstanceOf(HttpException);
      expect(error.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      expect(error.getResponse().code).toBe('ACCOUNT_TEMPORARILY_LOCKED');
      expect(error.getResponse().retryAfter).toBe(600);

      // Critical check: Neither DB query nor expensive bcrypt comparison were ever executed!
      expect(mockRepo.findUserByEmail).not.toHaveBeenCalled();
      expect(mockedBcrypt.compare).not.toHaveBeenCalled();
    });

    it('clears failed logins counter upon successful password authentication', async () => {
      const targetEmail = 'user@flux.ai';
      const mockUser = {
        id: 'user-789',
        email: targetEmail,
        password: '$2b$10$validhash',
        status: 'active',
        profile: { name: 'Valid User' },
      };
      mockRepo.findUserByEmail.mockResolvedValue(mockUser as any);

      // Simulate 2 previous fails
      await authService.recordFailedLogin(targetEmail);
      await authService.recordFailedLogin(targetEmail);
      const failKey = `identity:auth:fails:${targetEmail}`;
      expect(memoryStore.get(failKey)?.value).toBe(2);

      // Correct password
      mockedBcrypt.compare.mockResolvedValue(true as never);
      mockRepo.createSession.mockResolvedValue({ id: 'sess-1' } as any);

      const result = await authService.login({ email: targetEmail, password: 'CorrectPassword' });
      expect(result).toBeDefined();

      // Verify failed counter was wiped out
      expect(memoryStore.has(failKey)).toBe(false);
    });

    it('clears failed login count when password is reset with valid reset token', async () => {
      const targetEmail = 'forgotten@flux.ai';
      const userId = 'user-reset-456';
      const token = 'valid-crypto-reset-token';

      // Setup state: account was locked and failed count was 5
      await authService.lockAccount(targetEmail, 900);
      await authService.recordFailedLogin(targetEmail);

      mockRedis.get.mockImplementation((k: string) => {
        if (k === `identity:reset:${token}`) {
          return Promise.resolve({ userId } as any);
        }
        return Promise.resolve(null);
      });

      mockRepo.findUserById.mockResolvedValue({
        id: userId,
        email: targetEmail,
      } as any);

      mockedBcrypt.hash.mockResolvedValue('$2b$10$newhashedpassword' as never);

      await authService.resetPassword(token, 'BrandNewPassword123!');

      // Verify lockout and fails were cleared
      const lockKey = `identity:auth:locked:${targetEmail}`;
      const failKey = `identity:auth:fails:${targetEmail}`;
      expect(memoryStore.has(lockKey)).toBe(false);
      expect(memoryStore.has(failKey)).toBe(false);
    });
  });
});
