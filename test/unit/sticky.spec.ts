import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, ForbiddenException } from '@nestjs/common';
import { StickyService } from '@/modules/sticky/sticky.service';
import { StickyRepository } from '@/modules/sticky/sticky.repository';
import { RedisCacheService } from '@/core/cache/redis.service';
import { PrismaService } from '@/core/database/prisma.service';

describe('StickyService (Two-Tier Zero-Workspace Architecture)', () => {
  let service: StickyService;
  let repository: Partial<StickyRepository>;
  let cache: Partial<RedisCacheService>;
  let prisma: any;

  const mockUser = {
    id: 'user-1111-1111-1111-111111111111',
    name: 'Test User',
    email: 'test@example.com',
    avatar: null,
  };

  const mockOtherUser = {
    id: 'user-2222-2222-2222-222222222222',
    name: 'Other User',
    email: 'other@example.com',
    avatar: null,
  };

  const mockProjectId = 'proj-3333-3333-3333-333333333333';

  const mockPersonalSticky = {
    id: 'sticky-1111-1111-1111-111111111111',
    title: 'Personal Note',
    content: 'My ideas',
    color: 'yellow-1',
    scope: 'personal',
    positionX: 10,
    positionY: 20,
    order: 0,
    userId: mockUser.id,
    projectId: null,
    user: mockUser,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockProjectSticky = {
    id: 'sticky-2222-2222-2222-222222222222',
    title: 'Project Brainstorming Note',
    content: 'Team ideas',
    color: 'blue-1',
    scope: 'project',
    positionX: 50,
    positionY: 80,
    order: 0,
    userId: mockUser.id,
    projectId: mockProjectId,
    user: mockUser,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    repository = {
      findStickyById: jest.fn(),
      findStickiesByUserId: jest.fn(),
      countStickiesByUserId: jest.fn(),
      findStickiesByProjectId: jest.fn(),
      countStickiesByProjectId: jest.fn(),
      createSticky: jest.fn(),
      updateSticky: jest.fn(),
      deleteSticky: jest.fn(),
      findStickiesByIds: jest.fn(),
      reorderStickies: jest.fn(),
    };

    cache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
    };

    prisma = {
      project: {
        findFirst: jest.fn().mockResolvedValue({ id: mockProjectId }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StickyService,
        { provide: StickyRepository, useValue: repository },
        { provide: RedisCacheService, useValue: cache },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<StickyService>(StickyService);
  });

  describe('Personal Canvas (Tier 1)', () => {
    describe('getStickies (Personal)', () => {
      it('should return personal stickies with formatted 2D position and cache result', async () => {
        (repository.findStickiesByUserId as jest.Mock).mockResolvedValue([
          mockPersonalSticky,
        ]);

        const result = await service.getStickies(mockUser.id);

        expect(result.stickies).toHaveLength(1);
        expect(result.stickies[0].id).toBe(mockPersonalSticky.id);
        expect(result.stickies[0].position).toEqual({ x: 10, y: 20 });
        expect(repository.findStickiesByUserId).toHaveBeenCalledWith(
          mockUser.id,
        );
        expect(cache.set).toHaveBeenCalledTimes(1);
      });

      it('should return cached stickies if available in Redis', async () => {
        cache.get = jest.fn().mockResolvedValueOnce({
          stickies: [{ ...mockPersonalSticky, position: { x: 10, y: 20 } }],
        });

        const result = await service.getStickies(mockUser.id);

        expect(result.stickies).toHaveLength(1);
        expect(repository.findStickiesByUserId).not.toHaveBeenCalled();
      });
    });

    describe('createSticky (Personal)', () => {
      it('should create personal sticky with sequential order and invalidate cache', async () => {
        (repository.countStickiesByUserId as jest.Mock).mockResolvedValue(0);
        (repository.createSticky as jest.Mock).mockResolvedValue(
          mockPersonalSticky,
        );

        const result = await service.createSticky(mockUser.id, {
          title: 'New note',
          content: 'Content',
          position: { x: 5, y: 5 },
        });

        expect(result.sticky?.id).toBe(mockPersonalSticky.id);
        expect(repository.createSticky).toHaveBeenCalledWith(
          expect.objectContaining({
            userId: mockUser.id,
            scope: 'personal',
            order: 0,
          }),
        );
        expect(cache.del).toHaveBeenCalled();
      });
    });

    describe('updateSticky (Personal)', () => {
      it('should throw NotFoundException if sticky does not exist', async () => {
        (repository.findStickyById as jest.Mock).mockResolvedValue(null);

        await expect(
          service.updateSticky('sticky-unknown', mockUser.id, {
            title: 'Updated',
          }),
        ).rejects.toThrow(NotFoundException);
      });

      it('should throw ForbiddenException if updating another user personal sticky', async () => {
        (repository.findStickyById as jest.Mock).mockResolvedValue(
          mockPersonalSticky,
        );

        await expect(
          service.updateSticky(mockPersonalSticky.id, mockOtherUser.id, {
            title: 'Updated',
          }),
        ).rejects.toThrow(ForbiddenException);
      });

      it('should update personal sticky if caller is owner', async () => {
        (repository.findStickyById as jest.Mock).mockResolvedValue(
          mockPersonalSticky,
        );
        (repository.updateSticky as jest.Mock).mockResolvedValue({
          ...mockPersonalSticky,
          title: 'Updated Note',
        });

        const result = await service.updateSticky(
          mockPersonalSticky.id,
          mockUser.id,
          { title: 'Updated Note' },
        );

        expect(result.sticky?.title).toBe('Updated Note');
        expect(cache.del).toHaveBeenCalled();
      });
    });

    describe('deleteSticky (Personal)', () => {
      it('should throw ForbiddenException if deleting another user personal sticky', async () => {
        (repository.findStickyById as jest.Mock).mockResolvedValue(
          mockPersonalSticky,
        );

        await expect(
          service.deleteSticky(mockPersonalSticky.id, mockOtherUser.id),
        ).rejects.toThrow(ForbiddenException);
      });

      it('should delete personal sticky if caller is owner', async () => {
        (repository.findStickyById as jest.Mock).mockResolvedValue(
          mockPersonalSticky,
        );
        (repository.deleteSticky as jest.Mock).mockResolvedValue(
          mockPersonalSticky,
        );

        const result = await service.deleteSticky(
          mockPersonalSticky.id,
          mockUser.id,
        );

        expect(result.success).toBe(true);
        expect(repository.deleteSticky).toHaveBeenCalledWith(
          mockPersonalSticky.id,
        );
        expect(cache.del).toHaveBeenCalled();
      });
    });

    describe('reorderStickies (Personal)', () => {
      it('should throw ForbiddenException if any sticky does not belong to caller', async () => {
        (repository.findStickiesByIds as jest.Mock).mockResolvedValue([
          mockPersonalSticky,
          { ...mockPersonalSticky, id: 'sticky-2', userId: mockOtherUser.id },
        ]);

        await expect(
          service.reorderStickies(
            [mockPersonalSticky.id, 'sticky-2'],
            mockUser.id,
          ),
        ).rejects.toThrow(ForbiddenException);
      });

      it('should reorder successfully when all stickies belong to caller', async () => {
        const sticky2 = {
          ...mockPersonalSticky,
          id: 'sticky-2222-2222-2222-222222222223',
        };
        (repository.findStickiesByIds as jest.Mock).mockResolvedValue([
          mockPersonalSticky,
          sticky2,
        ]);
        (repository.reorderStickies as jest.Mock).mockResolvedValue([
          mockPersonalSticky,
          sticky2,
        ]);

        const result = await service.reorderStickies(
          [mockPersonalSticky.id, sticky2.id],
          mockUser.id,
        );

        expect(result.success).toBe(true);
        expect(repository.reorderStickies).toHaveBeenCalledWith([
          mockPersonalSticky.id,
          sticky2.id,
        ]);
        expect(cache.del).toHaveBeenCalled();
      });
    });
  });

  describe('Project Collaborative Canvas (Tier 2)', () => {
    describe('getStickies (Project)', () => {
      it('should verify project access and return project-scoped stickies', async () => {
        (repository.findStickiesByProjectId as jest.Mock).mockResolvedValue([
          mockProjectSticky,
        ]);

        const result = await service.getStickies(mockUser.id, mockProjectId);

        expect(prisma.project.findFirst).toHaveBeenCalledWith({
          where: {
            id: mockProjectId,
            deletedAt: null,
            OR: [
              { createdById: mockUser.id },
              { members: { some: { userId: mockUser.id } } },
            ],
          },
          select: { id: true },
        });
        expect(repository.findStickiesByProjectId).toHaveBeenCalledWith(
          mockProjectId,
        );
        expect(result.stickies).toHaveLength(1);
        expect(result.stickies[0].id).toBe(mockProjectSticky.id);
        expect(result.stickies[0].position).toEqual({ x: 50, y: 80 });
      });

      it('should throw ForbiddenException if caller has no access to project', async () => {
        prisma.project.findFirst.mockResolvedValueOnce(null);

        await expect(
          service.getStickies(mockOtherUser.id, mockProjectId),
        ).rejects.toThrow(ForbiddenException);
      });
    });

    describe('createSticky (Project)', () => {
      it('should create project sticky with scope project and invalidate project cache', async () => {
        (repository.countStickiesByProjectId as jest.Mock).mockResolvedValue(3);
        (repository.createSticky as jest.Mock).mockResolvedValue(
          mockProjectSticky,
        );

        const result = await service.createSticky(mockUser.id, {
          title: 'Project Idea',
          content: 'Brainstormed point',
          projectId: mockProjectId,
        });

        expect(result.sticky?.id).toBe(mockProjectSticky.id);
        expect(repository.createSticky).toHaveBeenCalledWith(
          expect.objectContaining({
            userId: mockUser.id,
            projectId: mockProjectId,
            scope: 'project',
            order: 3,
          }),
        );
        expect(cache.del).toHaveBeenCalled();
      });

      it('should throw ForbiddenException if user cannot access project when creating sticky', async () => {
        prisma.project.findFirst.mockResolvedValueOnce(null);

        await expect(
          service.createSticky(mockOtherUser.id, {
            content: 'Illegal Note',
            projectId: mockProjectId,
          }),
        ).rejects.toThrow(ForbiddenException);
      });
    });

    describe('updateSticky & deleteSticky (Project)', () => {
      it('should allow project member to update project sticky note', async () => {
        (repository.findStickyById as jest.Mock).mockResolvedValue(
          mockProjectSticky,
        );
        (repository.updateSticky as jest.Mock).mockResolvedValue({
          ...mockProjectSticky,
          title: 'Updated Project Note',
        });

        const result = await service.updateSticky(
          mockProjectSticky.id,
          mockUser.id,
          { title: 'Updated Project Note' },
        );

        expect(result.sticky?.title).toBe('Updated Project Note');
        expect(prisma.project.findFirst).toHaveBeenCalled();
        expect(cache.del).toHaveBeenCalled();
      });

      it('should allow project member to delete project sticky note', async () => {
        (repository.findStickyById as jest.Mock).mockResolvedValue(
          mockProjectSticky,
        );
        (repository.deleteSticky as jest.Mock).mockResolvedValue(
          mockProjectSticky,
        );

        const result = await service.deleteSticky(
          mockProjectSticky.id,
          mockUser.id,
        );

        expect(result.success).toBe(true);
        expect(prisma.project.findFirst).toHaveBeenCalled();
        expect(cache.del).toHaveBeenCalled();
      });
    });

    describe('reorderStickies (Project)', () => {
      it('should reorder project stickies if caller has project access', async () => {
        (repository.findStickiesByIds as jest.Mock).mockResolvedValue([
          mockProjectSticky,
        ]);
        (repository.reorderStickies as jest.Mock).mockResolvedValue([
          mockProjectSticky,
        ]);

        const result = await service.reorderStickies(
          [mockProjectSticky.id],
          mockUser.id,
          mockProjectId,
        );

        expect(result.success).toBe(true);
        expect(prisma.project.findFirst).toHaveBeenCalled();
        expect(cache.del).toHaveBeenCalled();
      });
    });
  });
});
