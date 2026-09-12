import { NotFoundException } from '@nestjs/common';
import { UserService } from '@/modules/iam/user/user.service';
import { UserRepository } from '@/modules/iam/user/user.repository';
import { IdentityRepository } from '@/modules/iam/user/identity.repository';
import { PrismaService } from '@/core/database/prisma.service';

describe('IAM Module — User Settings & Profile Unit Tests (Matt Pocock Seam 3)', () => {
  let userService: UserService;
  let userRepo: UserRepository;
  let identityRepo: IdentityRepository;
  let mockPrisma: any;

  const mockUser = {
    id: '11111111-1111-4111-a111-111111111111',
    email: 'researcher@flux.study',
    password: 'hashedpassword',
    name: 'Dr. Researcher',
    avatar: 'https://avatar.url',
    isVerified: true,
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    googleId: null,
    githubId: null,
  };

  beforeEach(() => {
    mockPrisma = {
      user: {
        findUnique: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn(),
      },
      userSettings: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      refreshToken: {
        updateMany: jest.fn(),
      },
      federatedIdentity: {
        findMany: jest.fn(),
        deleteMany: jest.fn(),
      },
    };

    userRepo = new UserRepository(mockPrisma as unknown as PrismaService);
    identityRepo = new IdentityRepository(mockPrisma as unknown as PrismaService);
    userService = new UserService(userRepo, identityRepo);
  });

  describe('UserRepository — Isolated UserSettings', () => {
    it('returns default settings if user has no settings record', async () => {
      mockPrisma.userSettings.findUnique.mockResolvedValue(null);

      const settings = await userRepo.getUserSettings(mockUser.id);
      expect(settings).toEqual({
        theme: 'system',
        citationStyle: 'apa',
        locale: 'en',
      });
      expect(mockPrisma.userSettings.findUnique).toHaveBeenCalledWith({
        where: { userId: mockUser.id },
      });
    });

    it('creates new settings record if none exists on update', async () => {
      mockPrisma.userSettings.findUnique.mockResolvedValue(null);
      mockPrisma.userSettings.create.mockResolvedValue({
        userId: mockUser.id,
        theme: 'dark',
        citationStyle: 'ieee',
        locale: 'vi',
        editorConfig: { vimMode: true },
        notifications: {},
        aiPreferences: {},
      });

      const updated = await userRepo.updateUserSettings(mockUser.id, {
        theme: 'dark',
        citationStyle: 'ieee',
        locale: 'vi',
        editorConfig: { vimMode: true },
      });

      expect(updated.theme).toBe('dark');
      expect(updated.citationStyle).toBe('ieee');
      expect(updated.locale).toBe('vi');
      expect(mockPrisma.userSettings.create).toHaveBeenCalled();
    });

    it('updates existing settings record if one exists', async () => {
      mockPrisma.userSettings.findUnique.mockResolvedValue({
        userId: mockUser.id,
        theme: 'light',
        citationStyle: 'apa',
        locale: 'en',
        editorConfig: {},
        notifications: {},
        aiPreferences: {},
      });
      mockPrisma.userSettings.update.mockResolvedValue({
        userId: mockUser.id,
        theme: 'dark',
        citationStyle: 'mla',
        locale: 'fr',
        editorConfig: {},
        notifications: {},
        aiPreferences: {},
      });

      const updated = await userRepo.updateUserSettings(mockUser.id, {
        theme: 'dark',
        citationStyle: 'mla',
        locale: 'fr',
      });

      expect(updated.theme).toBe('dark');
      expect(updated.citationStyle).toBe('mla');
      expect(mockPrisma.userSettings.update).toHaveBeenCalledWith({
        where: { userId: mockUser.id },
        data: expect.objectContaining({
          theme: 'dark',
          citationStyle: 'mla',
          locale: 'fr',
        }),
      });
    });
  });

  describe('UserService — Profile and Settings Facade', () => {
    it('getMe returns sanitized user with settings', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUser);
      mockPrisma.userSettings.findUnique.mockResolvedValue({
        userId: mockUser.id,
        theme: 'dark',
        citationStyle: 'apa',
        locale: 'en',
        editorConfig: {},
        notifications: {},
        aiPreferences: {},
      });

      const res = await userService.getMe(mockUser.id);
      expect(res.user.id).toBe(mockUser.id);
      expect(res.user.email).toBe(mockUser.email);
      expect((res.user as any).password).toBeUndefined();
      expect(res.user.settings.theme).toBe('dark');
    });

    it('getMe throws NotFoundException if user does not exist', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      await expect(userService.getMe('non-existent')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('updateProfile updates name and avatar', async () => {
      mockPrisma.user.update.mockResolvedValue({
        ...mockUser,
        name: 'Prof. Updated',
        avatar: 'https://new-avatar.url',
      });

      const res = await userService.updateProfile(mockUser.id, {
        name: 'Prof. Updated',
        avatar: 'https://new-avatar.url',
      });

      expect(res.user?.name).toBe('Prof. Updated');
      expect(res.user?.avatar).toBe('https://new-avatar.url');
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: mockUser.id },
        data: { name: 'Prof. Updated', avatar: 'https://new-avatar.url' },
      });
    });
  });
});
