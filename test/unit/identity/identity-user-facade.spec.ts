import { BadRequestException, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthProvider } from '@prisma/client';
import { fromPartial } from '@total-typescript/shoehorn';
import * as bcrypt from 'bcrypt';
import type { RedisCacheService } from '@/core';
import { AuditService } from '@/modules/identity/audit/audit.service';
import { IDENTITY_REDIS_KEYS } from '@/modules/identity/core/constants/identity.constant';
import {
  AUDIT_ACTIONS,
  AuditOutcome,
  AuditSeverity,
  IdentityFacade,
} from '@/modules/identity/identity.facade';
import { UserRepository } from '@/modules/identity/user/user.repository';
import { UserService } from '@/modules/identity/user/user.service';

describe('Identity UserService, Nuclear Token Revocation & IdentityFacade Suite', () => {
  describe('UserService (Account Deactivation, Password Change & OAuth Unlinking)', () => {
    let userService: UserService;
    let mockUserRepo: jest.Mocked<UserRepository>;
    let mockAudit: jest.Mocked<AuditService>;
    let mockRedis: jest.Mocked<RedisCacheService>;

    const userId = 'user-123';

    beforeEach(() => {
      mockUserRepo = fromPartial<jest.Mocked<UserRepository>>({
        findById: jest.fn(),
        findOwnedProjects: jest.fn().mockResolvedValue([]),
        archiveProjects: jest.fn().mockResolvedValue(1),
        deactivateAccount: jest.fn().mockResolvedValue(undefined),
        unlinkAccount: jest.fn().mockResolvedValue(undefined),
        updateUser: jest.fn().mockResolvedValue({}),
        revokeAllUserRefreshTokens: jest.fn().mockResolvedValue({ count: 3 }),
      });
      mockAudit = fromPartial<jest.Mocked<AuditService>>({
        record: jest.fn().mockResolvedValue(undefined),
      });
      mockRedis = fromPartial<jest.Mocked<RedisCacheService>>({
        set: jest.fn().mockResolvedValue(undefined),
      });

      userService = new UserService(mockUserRepo, mockAudit, mockRedis);
    });

    it('blocks deleteMe for collaborative sole-owners, rejects missing/suspended users, and auto-archives solo projects with nuclear Redis revocation', async () => {
      mockUserRepo.findById.mockResolvedValueOnce(null);
      await expect(userService.deleteMe(userId)).rejects.toThrow(
        NotFoundException,
      );

      mockUserRepo.findById.mockResolvedValueOnce(
        fromPartial({ id: userId, status: 'suspended' }),
      );
      await expect(userService.deleteMe(userId)).rejects.toThrow(
        BadRequestException,
      );

      // Sole owner of 3-member collaborative project blocked
      mockUserRepo.findById.mockResolvedValueOnce(
        fromPartial({ id: userId, status: 'active' }),
      );
      mockUserRepo.findOwnedProjects.mockResolvedValueOnce([
        fromPartial({
          id: 'proj-collab',
          name: 'Collab Project',
          identifier: 'COL',
          isArchived: false,
          memberCount: 3,
        }),
      ]);
      await expect(userService.deleteMe(userId)).rejects.toThrow(
        BadRequestException,
      );
      expect(mockUserRepo.deactivateAccount).not.toHaveBeenCalled();

      // Solo project auto-archived + CADF audit + 7d Redis revocation timestamp
      mockUserRepo.findById.mockResolvedValueOnce(
        fromPartial({ id: userId, status: 'active' }),
      );
      mockUserRepo.findOwnedProjects.mockResolvedValueOnce([
        fromPartial({
          id: 'proj-solo',
          name: 'Solo Project',
          identifier: 'SOLO',
          isArchived: false,
          memberCount: 1,
        }),
      ]);

      await expect(userService.deleteMe(userId)).resolves.toMatchObject({
        success: true,
      });
      expect(mockUserRepo.archiveProjects).toHaveBeenCalledWith(['proj-solo']);
      expect(mockUserRepo.deactivateAccount).toHaveBeenCalledWith(userId);
      expect(mockRedis.set).toHaveBeenCalledWith(
        IDENTITY_REDIS_KEYS.revoked(userId),
        expect.any(Number),
        7 * 86400,
      );
      expect(mockAudit.record).toHaveBeenCalledWith({
        actorId: userId,
        action: AUDIT_ACTIONS.AUTH_ACCOUNT_DEACTIVATED,
        outcome: AuditOutcome.success,
        severity: AuditSeverity.warning,
        targetType: 'user',
        targetId: userId,
      });
    });

    it('sets global Redis revocation timestamp on changePassword and records CADF audit on unlinkIdentity', async () => {
      const hashedOldPassword = await bcrypt.hash('OldSecurePassword123!', 10);
      mockUserRepo.findById.mockResolvedValueOnce(
        fromPartial({ id: userId, password: hashedOldPassword }),
      );

      await userService.changePassword(userId, {
        currentPassword: 'OldSecurePassword123!',
        newPassword: 'NewSecurePassword456!',
      });

      expect(mockUserRepo.revokeAllUserRefreshTokens).toHaveBeenCalledWith(
        userId,
      );
      expect(mockRedis.set).toHaveBeenCalledWith(
        IDENTITY_REDIS_KEYS.revoked(userId),
        expect.any(Number),
        7 * 86400,
      );

      mockAudit.record.mockClear();
      await expect(
        userService.unlinkIdentity(userId, AuthProvider.github),
      ).resolves.toMatchObject({ success: true });
      expect(mockUserRepo.unlinkAccount).toHaveBeenCalledWith(
        userId,
        AuthProvider.github,
      );
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AUDIT_ACTIONS.AUTH_OAUTH_ACCOUNT_UNLINKED,
          metadata: { provider: AuthProvider.github },
        }),
      );
    });
  });

  describe('IdentityFacade', () => {
    it('verifies tokens for active users, rejects suspended/expired tokens, validates users, and forwards CADF audit records', async () => {
      const verifyAsync = jest.fn();
      const findById = jest.fn();
      const record = jest.fn().mockResolvedValue(undefined);

      const facade = new IdentityFacade(
        fromPartial<UserService>({}),
        fromPartial<UserRepository>({ findById }),
        fromPartial<AuditService>({ record }),
        fromPartial<JwtService>({ verifyAsync }),
      );

      verifyAsync.mockResolvedValueOnce({ sub: 'user-123' });
      findById.mockResolvedValueOnce({
        id: 'user-123',
        email: 'alice@example.com',
        status: 'active',
        profile: { name: 'Alice', avatar: 'https://avatar.png' },
      });
      await expect(facade.verifyToken('valid-token')).resolves.toMatchObject({
        valid: true,
        user: {
          userId: 'user-123',
          email: 'alice@example.com',
          name: 'Alice',
          isVerified: true,
        },
      });

      verifyAsync.mockResolvedValueOnce({ sub: 'user-suspended' });
      findById.mockResolvedValueOnce({
        id: 'user-suspended',
        email: 'bad@example.com',
        status: 'suspended',
        profile: { name: 'Suspended User', avatar: null },
      });
      const suspended = await facade.verifyToken('valid-token');
      expect(suspended.valid).toBe(false);
      expect(suspended.error).toContain('inactive, suspended or not found');

      verifyAsync.mockRejectedValueOnce(new Error('jwt expired'));
      await expect(facade.verifyToken('expired')).resolves.toEqual({
        valid: false,
        error: 'jwt expired',
      });

      findById.mockResolvedValueOnce({
        id: 'user-456',
        email: 'bob@example.com',
        status: 'active',
        profile: { name: 'Bob', avatar: null },
      });
      await expect(facade.validateUser('user-456')).resolves.toMatchObject({
        userId: 'user-456',
        name: 'Bob',
      });

      findById.mockResolvedValueOnce(null);
      await expect(facade.validateUser('ghost')).resolves.toBeNull();

      const payload = {
        actorId: 'user-admin',
        action: AUDIT_ACTIONS.AUTH_TOKEN_REVOKED,
        outcome: AuditOutcome.success,
        severity: AuditSeverity.info,
        targetType: 'user',
        targetId: 'user-123',
      };
      await facade.recordAudit(payload);
      expect(record).toHaveBeenCalledWith(payload);
    });
  });
});
