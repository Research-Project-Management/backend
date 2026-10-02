import {
  IdentityFacade,
  AUDIT_ACTIONS,
  AuditOutcome,
  AuditSeverity,
} from '@/modules/identity/identity.facade';

describe('IdentityFacade (Clean Architecture Unified Facade)', () => {
  let facade: IdentityFacade;
  let mockUserService: {
    searchUsers: jest.Mock;
    getUserStats: jest.Mock;
  };
  let mockUserRepository: {
    findById: jest.Mock;
    findByEmail: jest.Mock;
  };
  let mockAuditService: {
    record: jest.Mock;
  };
  let mockJwtService: {
    verifyAsync: jest.Mock;
  };

  beforeEach(() => {
    mockUserService = {
      searchUsers: jest.fn(),
      getUserStats: jest.fn(),
    };
    mockUserRepository = {
      findById: jest.fn(),
      findByEmail: jest.fn(),
    };
    mockAuditService = {
      record: jest.fn().mockResolvedValue(undefined),
    };
    mockJwtService = {
      verifyAsync: jest.fn(),
    };

    facade = new IdentityFacade(
      mockUserService as any,
      mockUserRepository as any,
      mockAuditService as any,
      mockJwtService as any,
    );
  });

  describe('verifyToken', () => {
    it('should successfully verify token and return active user session', async () => {
      mockJwtService.verifyAsync.mockResolvedValue({ sub: 'user-123' });
      mockUserRepository.findById.mockResolvedValue({
        id: 'user-123',
        email: 'alice@example.com',
        status: 'active',
        profile: { name: 'Alice', avatar: 'https://avatar.png' },
      });

      const result = await facade.verifyToken('valid-token');

      expect(result.valid).toBe(true);
      expect(result.user).toBeDefined();
      expect(result.user?.userId).toBe('user-123');
      expect(result.user?.email).toBe('alice@example.com');
      expect(result.user?.name).toBe('Alice');
      expect(result.user?.isVerified).toBe(true);
    });

    it('should reject suspended user even if token is structurally valid', async () => {
      mockJwtService.verifyAsync.mockResolvedValue({ sub: 'user-suspended' });
      mockUserRepository.findById.mockResolvedValue({
        id: 'user-suspended',
        email: 'bad@example.com',
        status: 'suspended',
        profile: { name: 'Suspended User', avatar: null },
      });

      const result = await facade.verifyToken('valid-token');

      expect(result.valid).toBe(false);
      expect(result.error).toContain('inactive, suspended or not found');
      expect(result.user).toBeUndefined();
    });

    it('should return error when jwt verification throws', async () => {
      mockJwtService.verifyAsync.mockRejectedValue(new Error('jwt expired'));

      const result = await facade.verifyToken('expired-token');

      expect(result.valid).toBe(false);
      expect(result.error).toBe('jwt expired');
    });
  });

  describe('validateUser', () => {
    it('should return active session for existing active user', async () => {
      mockUserRepository.findById.mockResolvedValue({
        id: 'user-456',
        email: 'bob@example.com',
        status: 'active',
        profile: { name: 'Bob', avatar: null },
      });

      const session = await facade.validateUser('user-456');

      expect(session).not.toBeNull();
      expect(session?.userId).toBe('user-456');
      expect(session?.name).toBe('Bob');
    });

    it('should return null for non-existent or deactivated user', async () => {
      mockUserRepository.findById.mockResolvedValue(null);

      const session = await facade.validateUser('ghost-user');

      expect(session).toBeNull();
    });
  });

  describe('recordAudit', () => {
    it('should forward audit event directly into auditService CADF pipeline', async () => {
      const auditPayload = {
        actorId: 'user-admin',
        action: AUDIT_ACTIONS.AUTH_TOKEN_REVOKED,
        outcome: AuditOutcome.success,
        severity: AuditSeverity.info,
        targetType: 'user',
        targetId: 'user-123',
      };

      await facade.recordAudit(auditPayload);

      expect(mockAuditService.record).toHaveBeenCalledTimes(1);
      expect(mockAuditService.record).toHaveBeenCalledWith(auditPayload);
    });
  });
});
