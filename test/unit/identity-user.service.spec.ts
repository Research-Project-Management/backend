import { UserService } from '@/modules/identity/user/user.service';
import {
  AUDIT_ACTIONS,
  AuditOutcome,
  AuditSeverity,
} from '@/modules/identity/audit/types/audit.type';
import { AuthProvider } from '@prisma/client';
import { BadRequestException, NotFoundException } from '@nestjs/common';

describe('UserService (Identity Domain & Security Auditing)', () => {
  let userService: UserService;
  let mockUserRepo: {
    findById: jest.Mock;
    findOwnedProjects: jest.Mock;
    archiveProjects: jest.Mock;
    deactivateAccount: jest.Mock;
    unlinkAccount: jest.Mock;
    getUserSettings: jest.Mock;
    updateProfile: jest.Mock;
    updateUser: jest.Mock;
    revokeAllUserRefreshTokens: jest.Mock;
    searchUsers: jest.Mock;
  };
  let mockAuditService: {
    record: jest.Mock;
  };

  beforeEach(() => {
    mockUserRepo = {
      findById: jest.fn(),
      findOwnedProjects: jest.fn(),
      archiveProjects: jest.fn().mockResolvedValue(1),
      deactivateAccount: jest.fn().mockResolvedValue(undefined),
      unlinkAccount: jest.fn().mockResolvedValue(undefined),
      getUserSettings: jest.fn(),
      updateProfile: jest.fn(),
      updateUser: jest.fn(),
      revokeAllUserRefreshTokens: jest.fn(),
      searchUsers: jest.fn(),
    };
    mockAuditService = {
      record: jest.fn().mockResolvedValue(undefined),
    };

    userService = new UserService(mockUserRepo as any, mockAuditService as any);
  });

  describe('deleteMe (Account Deactivation & Invariant Preservation)', () => {
    const userId = 'user-123';

    it('should block deactivation if user is the sole owner of collaborative projects', async () => {
      mockUserRepo.findById.mockResolvedValue({
        id: userId,
        status: 'active',
      });
      mockUserRepo.findOwnedProjects.mockResolvedValue([
        {
          id: 'proj-collab',
          name: 'Collab Project',
          identifier: 'COL',
          isArchived: false,
          memberCount: 3, // More than 1 member -> collaborative
        },
      ]);

      await expect(userService.deleteMe(userId)).rejects.toThrow(
        BadRequestException,
      );
      expect(mockUserRepo.deactivateAccount).not.toHaveBeenCalled();
      expect(mockAuditService.record).not.toHaveBeenCalled();
    });

    it('should auto-archive solo projects and record security audit log on successful deactivation', async () => {
      mockUserRepo.findById.mockResolvedValue({
        id: userId,
        status: 'active',
      });
      mockUserRepo.findOwnedProjects.mockResolvedValue([
        {
          id: 'proj-solo',
          name: 'Solo Project',
          identifier: 'SOLO',
          isArchived: false,
          memberCount: 1, // Solo project
        },
      ]);

      const result = await userService.deleteMe(userId);

      expect(result.success).toBe(true);
      expect(mockUserRepo.archiveProjects).toHaveBeenCalledWith(['proj-solo']);
      expect(mockUserRepo.deactivateAccount).toHaveBeenCalledWith(userId);

      // Verify CADF audit event is recorded
      expect(mockAuditService.record).toHaveBeenCalledTimes(1);
      expect(mockAuditService.record).toHaveBeenCalledWith({
        actorId: userId,
        action: AUDIT_ACTIONS.AUTH_ACCOUNT_DEACTIVATED,
        outcome: AuditOutcome.success,
        severity: AuditSeverity.warning,
        targetType: 'user',
        targetId: userId,
      });
    });

    it('should reject deactivation for non-existent or suspended users', async () => {
      mockUserRepo.findById.mockResolvedValue(null);

      await expect(userService.deleteMe(userId)).rejects.toThrow(
        NotFoundException,
      );

      mockUserRepo.findById.mockResolvedValue({
        id: userId,
        status: 'suspended',
      });

      await expect(userService.deleteMe(userId)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('unlinkIdentity', () => {
    const userId = 'user-123';
    const provider = AuthProvider.github;

    it('should unlink account and record CADF audit event', async () => {
      const result = await userService.unlinkIdentity(userId, provider);

      expect(result.success).toBe(true);
      expect(mockUserRepo.unlinkAccount).toHaveBeenCalledWith(userId, provider);

      expect(mockAuditService.record).toHaveBeenCalledTimes(1);
      expect(mockAuditService.record).toHaveBeenCalledWith({
        actorId: userId,
        action: AUDIT_ACTIONS.AUTH_OAUTH_ACCOUNT_UNLINKED,
        outcome: AuditOutcome.success,
        severity: AuditSeverity.info,
        targetType: 'user',
        targetId: userId,
        metadata: { provider },
      });
    });
  });
});
