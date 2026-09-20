import { Test, TestingModule } from '@nestjs/testing';
import { StickyService } from '@/modules/sticky/sticky.service';
import { StickyRepository } from '@/modules/sticky/sticky.repository';
import { PrismaService } from '@/core/database/prisma.service';
import { ForbiddenException, NotFoundException } from '@nestjs/common';

describe('StickyService', () => {
  let service: StickyService;
  let repo: jest.Mocked<StickyRepository>;
  let prisma: jest.Mocked<PrismaService>;

  const mockUser = {
    id: '01920b92-1111-7111-8111-111111111111',
    email: 'researcher@flux.app',
    profile: {
      name: 'Researcher',
      avatar: null,
    },
  };

  const mockSticky = {
    id: '01920b92-7f12-7890-a123-456789abcdef',
    title: 'Hypothesis Note',
    content: '<p>Initial thesis argument</p>',
    color: 'yellow-1',
    positionX: 10,
    positionY: 20,
    order: 0,
    userId: mockUser.id,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    user: mockUser,
  };

  beforeEach(async () => {
    const mockRepo = {
      findStickyById: jest.fn(),
      findStickiesByUserId: jest.fn(),
      countStickiesByUserId: jest.fn(),
      createSticky: jest.fn(),
      updateSticky: jest.fn(),
      deleteSticky: jest.fn(),
      findStickiesByIds: jest.fn(),
      reorderStickies: jest.fn(),
    };

    const mockPrisma = {
      sticky: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StickyService,
        { provide: StickyRepository, useValue: mockRepo },
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<StickyService>(StickyService);
    repo = module.get(StickyRepository);
    prisma = module.get(PrismaService);
  });

  describe('getStickies', () => {
    it('should return formatted personal stickies', async () => {
      repo.findStickiesByUserId.mockResolvedValue([mockSticky]);

      const result = await service.getStickies(mockUser.id);

      expect(repo.findStickiesByUserId).toHaveBeenCalledWith(mockUser.id);
      expect(result.stickies).toHaveLength(1);
      expect(result.stickies[0].position).toEqual({ x: 10, y: 20 });
    });

    it('should search personal stickies when search keyword is provided', async () => {
      repo.findStickiesByUserId.mockResolvedValue([mockSticky]);

      const result = await service.getStickies(mockUser.id, 'thesis');

      expect(repo.findStickiesByUserId).toHaveBeenCalledWith(
        mockUser.id,
        'thesis',
      );
      expect(result.stickies).toHaveLength(1);
    });
  });

  describe('createSticky', () => {
    it('should create personal sticky with order based on user count and assign a valid UUID v7', async () => {
      repo.countStickiesByUserId.mockResolvedValue(2);
      (prisma.sticky.findFirst as jest.Mock).mockResolvedValue(null);
      repo.createSticky.mockResolvedValue({
        ...mockSticky,
        order: 2,
      });

      const result = await service.createSticky(mockUser.id, {
        title: 'New Note',
        content: '<p>Content</p>',
        color: 'mint-1',
      });

      expect(repo.countStickiesByUserId).toHaveBeenCalledWith(mockUser.id);
      expect(repo.createSticky).toHaveBeenCalledWith(
        expect.objectContaining({
          id: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
          ),
          title: 'New Note',
          content: '<p>Content</p>',
          color: 'mint-1',
          positionX: 0,
          positionY: 0,
          order: 2,
          userId: mockUser.id,
        }),
      );
      expect(result.sticky?.order).toBe(2);
    });

    it('should reject creating a new sticky if the latest note is still empty', async () => {
      (prisma.sticky.findFirst as jest.Mock).mockResolvedValue({
        id: 'latest-empty',
        title: '',
        content: '<p></p>',
        color: 'yellow-1',
      });

      await expect(
        service.createSticky(mockUser.id, { content: '<p></p>' }),
      ).rejects.toThrow(
        'Please add content to your existing draft note before creating a new one',
      );
    });

    it('should automatically rotate color and sanitize script tags', async () => {
      repo.countStickiesByUserId.mockResolvedValue(1);
      (prisma.sticky.findFirst as jest.Mock).mockResolvedValue({
        id: 'prev-note',
        title: 'Previous Note',
        content: '<p>Active research ideas</p>',
        color: 'yellow-1',
      });
      repo.createSticky.mockResolvedValue({
        ...mockSticky,
        color: 'lavender-1',
      });

      await service.createSticky(mockUser.id, {
        content: '<p>Valid text<script>alert("xss")</script></p>',
      });

      expect(repo.createSticky).toHaveBeenCalledWith(
        expect.objectContaining({
          color: 'lavender-1', // Next color after yellow-1
          content: '<p>Valid text</p>', // Script tag stripped by server DOMPurify
        }),
      );
    });
  });

  describe('deleteSticky', () => {
    it('should throw NotFoundException when sticky not found', async () => {
      repo.findStickyById.mockResolvedValue(null);

      await expect(
        service.deleteSticky('non-existent', mockUser.id),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException when deleting another user personal sticky', async () => {
      repo.findStickyById.mockResolvedValue({
        ...mockSticky,
        userId: 'other-user',
      });

      await expect(
        service.deleteSticky(mockSticky.id, mockUser.id),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should call deleteSticky on repository when authorized', async () => {
      repo.findStickyById.mockResolvedValue(mockSticky);
      repo.deleteSticky.mockResolvedValue({
        ...mockSticky,
        deletedAt: new Date(),
      });

      const res = await service.deleteSticky(mockSticky.id, mockUser.id);
      expect(repo.deleteSticky).toHaveBeenCalledWith(mockSticky.id);
      expect(res.success).toBe(true);
    });
  });

  describe('getStickyById', () => {
    it('should throw NotFoundException when sticky not found', async () => {
      repo.findStickyById.mockResolvedValue(null);

      await expect(
        service.getStickyById('non-existent', mockUser.id),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException when accessing another user sticky', async () => {
      repo.findStickyById.mockResolvedValue({
        ...mockSticky,
        userId: 'other-user',
      });

      await expect(
        service.getStickyById(mockSticky.id, mockUser.id),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should return formatted sticky when authorized', async () => {
      repo.findStickyById.mockResolvedValue(mockSticky);

      const result = await service.getStickyById(mockSticky.id, mockUser.id);

      expect(repo.findStickyById).toHaveBeenCalledWith(mockSticky.id);
      expect(result.sticky).toBeDefined();
      expect(result.sticky?.id).toBe(mockSticky.id);
      expect(result.sticky?.position).toEqual({ x: 10, y: 20 });
    });
  });
});
