import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { AuthnService } from '@/modules/iam/authn/authn.service';
import { AuthnRepository } from '@/modules/iam/authn/authn.repository';
import { FederatedIdentityRepository } from '@/modules/iam/user/federated-identity.repository';
import { AuditService } from '@/modules/iam/audit/audit.service';
import { RedisCacheService } from '@/core/cache/redis-cache.service';
import * as bcrypt from 'bcrypt';

jest.mock('bcrypt');

describe('AuthnService', () => {
  let service: AuthnService;
  let authnRepo: jest.Mocked<AuthnRepository>;
  let federatedRepo: jest.Mocked<FederatedIdentityRepository>;
  let auditService: jest.Mocked<AuditService>;
  let redis: jest.Mocked<RedisCacheService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthnService,
        {
          provide: AuthnRepository,
          useValue: {
            findUserByEmail: jest.fn(),
            findUserById: jest.fn(),
            findUserByOAuth: jest.fn(),
            createUser: jest.fn(),
            updateUser: jest.fn(),
            createSession: jest.fn().mockResolvedValue({ id: 'session-1' }),
            createRefreshToken: jest.fn(),
            findRefreshToken: jest.fn(),
            findByTokenHash: jest.fn(),
            rotateToken: jest.fn(),
            revokeToken: jest.fn(),
            revokeUserSession: jest.fn().mockResolvedValue(1),
            revokeRefreshToken: jest.fn(),
            revokeFamily: jest.fn(),
            revokeAllUserTokens: jest.fn(),
            revokeAllUserSessions: jest.fn().mockResolvedValue(2),
            findActiveSessionsByUser: jest.fn().mockResolvedValue([]),
            updateUserPassword: jest.fn(),
          },
        },
        {
          provide: FederatedIdentityRepository,
          useValue: {
            findByProviderSubject: jest.fn(),
            findByUserId: jest.fn(),
            linkIdentity: jest.fn(),
            unlinkIdentity: jest.fn(),
          },
        },
        {
          provide: AuditService,
          useValue: {
            log: jest.fn().mockResolvedValue(undefined),
            getRecentAuditLogs: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: JwtService,
          useValue: {
            signAsync: jest.fn().mockResolvedValue('mock-token'),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockImplementation((key) => {
              if (key === 'JWT_SECRET') return 'test-secret';
              if (key === 'JWT_REFRESH_SECRET') return 'test-refresh-secret';
              return null;
            }),
          },
        },
        {
          provide: RedisCacheService,
          useValue: {
            get: jest.fn(),
            set: jest.fn(),
            del: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<AuthnService>(AuthnService);
    authnRepo = module.get(AuthnRepository);
    federatedRepo = module.get(FederatedIdentityRepository);
    auditService = module.get(AuditService);
    redis = module.get(RedisCacheService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('Registration & Local Auth', () => {
    it('should throw BadRequestException if email already registered', async () => {
      authnRepo.findUserByEmail.mockResolvedValue({
        id: '1',
        email: 'test@example.com',
      } as any);

      await expect(
        service.registerUser({
          email: 'test@example.com',
          password: 'password123',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should register a new user and issue tokens', async () => {
      authnRepo.findUserByEmail.mockResolvedValue(null);
      (bcrypt.hash as jest.Mock).mockResolvedValue('hashed-password');
      authnRepo.createUser.mockResolvedValue({
        id: 'user-1',
        email: 'new@example.com',
        name: 'New User',
        password: 'hashed-password',
        avatar: null,
        isVerified: true,
        status: 'active',
      } as any);

      const result = await service.registerUser({
        email: 'new@example.com',
        password: 'password123',
        name: 'New User',
      });

      expect(result.user.email).toBe('new@example.com');
      expect(result.user.id).toBe('user-1');
      expect(result.accessToken).toBe('mock-token');
      expect(authnRepo.createSession).toHaveBeenCalled();
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'login_success' }),
      );
    });

    it('should throw UnauthorizedException on invalid login password', async () => {
      authnRepo.findUserByEmail.mockResolvedValue({
        id: 'user-1',
        email: 'user@example.com',
        password: 'hashed-password',
      } as any);
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      await expect(
        service.login({
          email: 'user@example.com',
          password: 'wrong-password',
        }),
      ).rejects.toThrow(UnauthorizedException);

      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'login_failed' }),
      );
    });
  });

  describe('Federated Identity (OAuth2)', () => {
    it('should link federated identity on new OAuth login', async () => {
      federatedRepo.findByProviderSubject.mockResolvedValue(null);
      authnRepo.findUserByEmail.mockResolvedValue(null);
      authnRepo.createUser.mockResolvedValue({
        id: 'user-oauth',
        email: 'oauth@example.com',
        name: 'OAuth User',
        avatar: 'https://avatar.url',
        isVerified: true,
        status: 'active',
      } as any);

      const result = await service.handleOAuth({
        id: 'google-sub-123',
        email: 'oauth@example.com',
        name: 'OAuth User',
        avatar: 'https://avatar.url',
        provider: 'google',
      });

      expect(result.user.id).toBe('user-oauth');
      expect(federatedRepo.linkIdentity).toHaveBeenCalledWith({
        userId: 'user-oauth',
        provider: 'google',
        providerSubjectId: 'google-sub-123',
        email: 'oauth@example.com',
        profileData: { name: 'OAuth User', avatar: 'https://avatar.url' },
      });
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'oauth_account_linked' }),
      );
    });
  });

  describe('Token Rotation & Breach Detection (User Story 3)', () => {
    it('should tolerate refresh race condition if token was revoked within grace window (<15s)', async () => {
      authnRepo.findRefreshToken.mockResolvedValue({
        id: 'token-recent',
        userId: 'user-1',
        familyId: 'family-101',
        isRevoked: true,
        revokedAt: new Date(Date.now() - 2000), // 2 seconds ago
        expiresAt: new Date(Date.now() + 100000),
      } as any);

      await expect(service.refresh('recent-token')).rejects.toThrow(
        UnauthorizedException,
      );

      // Should NOT revoke family during grace window
      expect(authnRepo.revokeFamily).not.toHaveBeenCalled();
    });

    it('should detect token breach and revoke family when stale revoked token (>15s) is replayed', async () => {
      authnRepo.findRefreshToken.mockResolvedValue({
        id: 'token-stale',
        userId: 'user-1',
        familyId: 'family-101',
        isRevoked: true,
        revokedAt: new Date(Date.now() - 30_000), // 30 seconds ago
        expiresAt: new Date(Date.now() + 100000),
      } as any);

      await expect(service.refresh('compromised-raw-token')).rejects.toThrow(
        UnauthorizedException,
      );

      expect(authnRepo.revokeFamily).toHaveBeenCalledWith('family-101');
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'token_breach_detected',
          metadata: expect.objectContaining({ familyId: 'family-101' }),
        }),
      );
    });

    it('should rotate token family safely when valid refresh token is presented', async () => {
      authnRepo.findRefreshToken.mockResolvedValue({
        id: 'token-valid-1',
        userId: 'user-1',
        familyId: 'family-202',
        isRevoked: false,
        revokedAt: null,
        expiresAt: new Date(Date.now() + 1000000),
        user: { id: 'user-1', email: 'u@example.com', name: 'U' },
      } as any);

      const result = await service.refresh('valid-refresh-token');

      expect(result.accessToken).toBe('mock-token');
      expect(authnRepo.rotateToken).toHaveBeenCalledWith(
        expect.objectContaining({
          oldTokenId: 'token-valid-1',
          familyId: 'family-202',
          userId: 'user-1',
        }),
      );
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'token_refreshed',
          metadata: expect.objectContaining({ familyId: 'family-202' }),
        }),
      );
    });
  });

  describe('Active Session Management', () => {
    it('should return sanitized active sessions', async () => {
      authnRepo.findActiveSessionsByUser.mockResolvedValue([
        {
          id: 'session-123',
          userId: 'user-1',
          token: 'stored-token',
          tokenHash: 'stored-token-hash',
          familyId: 'family-1',
          parentId: null,
          userAgent: 'browser',
          ipAddress: '127.0.0.1',
          deviceType: null,
          lastUsedAt: null,
          expiresAt: new Date(Date.now() + 100000),
          createdAt: new Date(),
          isRevoked: false,
        } as any,
      ]);

      const sessions = await service.getActiveSessions('user-1');

      expect(sessions).toHaveLength(1);
      expect(sessions[0]).not.toHaveProperty('token');
      expect(sessions[0]).not.toHaveProperty('tokenHash');
    });

    it('should revoke a single session and invalidate Redis key', async () => {
      await service.revokeSession('user-1', 'session-123');
      expect(authnRepo.revokeUserSession).toHaveBeenCalledWith(
        'user-1',
        'session-123',
      );
      expect(redis.del).toHaveBeenCalled();
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'token_revoked',
          targetId: 'session-123',
        }),
      );
    });

    it('should revoke all user sessions on global logout', async () => {
      const res = await service.revokeAllSessions('user-1');
      expect(res.revokedCount).toBe(2);
      expect(authnRepo.revokeAllUserSessions).toHaveBeenCalledWith('user-1');
    });
  });
});
