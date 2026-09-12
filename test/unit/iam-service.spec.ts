import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { IamService } from '@/modules/iam/core/iam.service';
import { AuthzService } from '@/modules/iam/authz/authz.service';
import { Role } from '@/modules/iam/authz/enums/role.enum';
import { Permission } from '@/modules/iam/authz/enums/permission.enum';

describe('IAM Module — IamService & AuthzService Unit Tests', () => {
  let iamService: IamService;
  let authzService: AuthzService;

  let mockUserService: any;
  let mockUserRepo: any;
  let mockAuthzRepo: any;
  let mockJwtService: any;
  let mockRedis: any;

  beforeEach(() => {
    mockUserService = {
      searchUsers: jest.fn(),
      getUserStats: jest.fn(),
    };

    mockUserRepo = {
      findById: jest.fn(),
      findByEmail: jest.fn(),
    };

    mockAuthzRepo = {
      findProjectContext: jest.fn(),
      findMemberRole: jest.fn(),
    };

    mockJwtService = {
      verifyAsync: jest.fn(),
    };

    mockRedis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
    };

    authzService = new AuthzService(mockAuthzRepo, mockRedis);
    iamService = new IamService(
      mockUserService,
      mockUserRepo,
      authzService,
      mockJwtService,
    );
  });

  describe('AuthzService — Role & Permission Evaluation', () => {
    it('returns true when role possesses the requested permission', () => {
      expect(authzService.hasPermission(Role.OWNER, Permission.PROJECT_DELETE)).toBe(true);
      expect(authzService.hasPermission(Role.CONTRIBUTOR, Permission.TASK_CREATE)).toBe(true);
      expect(authzService.hasPermission(Role.COMMENTER, Permission.COMMENT_CREATE)).toBe(true);
      expect(authzService.hasPermission(Role.VIEWER, Permission.PROJECT_READ)).toBe(true);
    });

    it('returns false when role lacks permission', () => {
      expect(authzService.hasPermission(Role.VIEWER, Permission.TASK_CREATE)).toBe(false);
      expect(authzService.hasPermission(Role.COMMENTER, Permission.PROJECT_DELETE)).toBe(false);
      expect(authzService.hasPermission(Role.CONTRIBUTOR, Permission.PROJECT_DELETE)).toBe(false);
    });

    it('evaluates role hierarchy correctly', () => {
      expect(authzService.hasRole(Role.OWNER, Role.CONTRIBUTOR)).toBe(true);
      expect(authzService.hasRole(Role.CONTRIBUTOR, Role.CONTRIBUTOR)).toBe(true);
      expect(authzService.hasRole(Role.COMMENTER, Role.CONTRIBUTOR)).toBe(false);
      expect(authzService.hasRole(Role.VIEWER, Role.COMMENTER)).toBe(false);
    });

    it('resolves OWNER when user is project creator', async () => {
      mockAuthzRepo.findProjectContext.mockResolvedValue({
        id: 'proj-1',
        createdById: 'user-creator',
      });

      const role = await authzService.getRole('proj-1', 'user-creator');
      expect(role).toBe(Role.OWNER);
      expect(mockRedis.set).toHaveBeenCalled();
    });

    it('resolves member role when user is not creator but has membership', async () => {
      mockAuthzRepo.findProjectContext.mockResolvedValue({
        id: 'proj-1',
        createdById: 'user-creator',
      });
      mockAuthzRepo.findMemberRole.mockResolvedValue(Role.CONTRIBUTOR);

      const role = await authzService.getRole('proj-1', 'user-member');
      expect(role).toBe(Role.CONTRIBUTOR);
    });

    it('returns null when user is neither creator nor member', async () => {
      mockAuthzRepo.findProjectContext.mockResolvedValue({
        id: 'proj-1',
        createdById: 'user-creator',
      });
      mockAuthzRepo.findMemberRole.mockResolvedValue(null);

      const role = await authzService.getRole('proj-1', 'user-stranger');
      expect(role).toBeNull();
    });

    it('uses cached role from Redis when available', async () => {
      mockRedis.get.mockResolvedValue(Role.COMMENTER);

      const role = await authzService.getRole('proj-1', 'user-cached');
      expect(role).toBe(Role.COMMENTER);
      expect(mockAuthzRepo.findProjectContext).not.toHaveBeenCalled();
    });

    it('requireRole throws ForbiddenException if user is not in project', async () => {
      mockAuthzRepo.findProjectContext.mockResolvedValue(null);
      mockAuthzRepo.findMemberRole.mockResolvedValue(null);

      await expect(
        authzService.requireRole('proj-1', 'user-stranger', Role.VIEWER),
      ).rejects.toThrow(ForbiddenException);
    });

    it('requireRole throws ForbiddenException if role hierarchy is insufficient', async () => {
      mockAuthzRepo.findProjectContext.mockResolvedValue({
        id: 'proj-1',
        createdById: 'user-creator',
      });
      mockAuthzRepo.findMemberRole.mockResolvedValue(Role.VIEWER);

      await expect(
        authzService.requireRole('proj-1', 'user-member', Role.CONTRIBUTOR),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('IamService Gateway Facade', () => {
    it('verifyToken succeeds for active user', async () => {
      mockJwtService.verifyAsync.mockResolvedValue({ sub: 'user-1' });
      mockUserRepo.findById.mockResolvedValue({
        id: 'user-1',
        email: 'test@example.com',
        name: 'Test User',
        avatar: null,
        status: 'active',
      });

      const result = await iamService.verifyToken('valid-token');
      expect(result.valid).toBe(true);
      expect(result.user?.userId).toBe('user-1');
    });

    it('verifyToken fails for inactive or non-existent user', async () => {
      mockJwtService.verifyAsync.mockResolvedValue({ sub: 'user-inactive' });
      mockUserRepo.findById.mockResolvedValue({
        id: 'user-inactive',
        status: 'suspended',
      });

      const result = await iamService.verifyToken('token-inactive');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('inactive or not found');
    });

    it('validateUser returns active user session or null', async () => {
      mockUserRepo.findById.mockResolvedValue({
        id: 'user-1',
        email: 'user@example.com',
        name: 'Active User',
        avatar: 'avatar.png',
        status: 'active',
      });

      const session = await iamService.validateUser('user-1');
      expect(session).toEqual({
        userId: 'user-1',
        email: 'user@example.com',
        name: 'Active User',
        avatar: 'avatar.png',
        status: 'active',
      });
    });

    it('getUserById throws NotFoundException when user not found', async () => {
      mockUserRepo.findById.mockResolvedValue(null);

      await expect(iamService.getUserById('non-existent')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('getUserProjectRole delegates to AuthzService', async () => {
      mockAuthzRepo.findProjectContext.mockResolvedValue({
        id: 'proj-1',
        createdById: 'user-creator',
      });

      const role = await iamService.getUserProjectRole('user-creator', 'proj-1');
      expect(role).toBe(Role.OWNER);
    });

    it('hasPermission returns true if granted and false if not', async () => {
      mockAuthzRepo.findProjectContext.mockResolvedValue({
        id: 'proj-1',
        createdById: 'user-creator',
      });

      const canDelete = await iamService.hasPermission(
        'user-creator',
        'proj-1',
        Permission.PROJECT_DELETE,
      );
      expect(canDelete).toBe(true);
    });

    it('checkRole checks minimum role level', async () => {
      mockAuthzRepo.findProjectContext.mockResolvedValue({
        id: 'proj-1',
        createdById: 'user-creator',
      });

      const isAtLeastContributor = await iamService.checkRole(
        'user-creator',
        'proj-1',
        Role.CONTRIBUTOR,
      );
      expect(isAtLeastContributor).toBe(true);
    });

    it('getProjectPermissions returns array of permission strings', async () => {
      mockAuthzRepo.findProjectContext.mockResolvedValue({
        id: 'proj-1',
        createdById: 'user-creator',
      });

      const perms = await iamService.getProjectPermissions('user-creator', 'proj-1');
      expect(perms).toContain(Permission.PROJECT_DELETE);
      expect(perms).toContain(Permission.TASK_CREATE);
    });
  });
});
