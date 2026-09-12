import { NotFoundException, ForbiddenException } from '@nestjs/common';
import { ViewService } from '@/modules/work-item/view/view.service';
import { ViewRepository } from '@/modules/work-item/view/view.repository';
import { WorkItemService } from '@/modules/work-item/core/work-item.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ViewAccess } from '@prisma/client';
import { WorkItemViewItem } from '@/modules/work-item/view/types/view.types';

describe('Saved Views (Issue Views) Module', () => {
  let service: ViewService;
  let mockRepo: {
    findProjectViews: jest.Mock;
    findById: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    toggleFavorite: jest.Mock;
    favorite: jest.Mock;
    unfavorite: jest.Mock;
    isFavorite: jest.Mock;
    findUserFavoriteViews: jest.Mock;
  };
  let mockEventEmitter: { emit: jest.Mock };
  let mockWorkItemService: { getProjectTasks: jest.Mock };

  const projectId = '10000000-0000-0000-0000-000000000001';
  const userId = '20000000-0000-0000-0000-000000000002';
  const otherUserId = '30000000-0000-0000-0000-000000000003';
  const viewId = '40000000-0000-0000-0000-000000000004';

  const mockPublicView: WorkItemViewItem = {
    id: viewId,
    name: 'Active Sprint Bugs',
    description: 'All bugs currently uncompleted',
    query: { priority: ['urgent', 'high'] },
    filters: { priority: ['urgent', 'high'] },
    displayFilters: { layout: 'board', groupBy: 'state' },
    displayProperties: { assignee: true, priority: true },
    richFilters: {},
    access: ViewAccess.public,
    sortOrder: 65535,
    logoProps: {},
    isLocked: false,
    projectId,
    createdById: userId,
    isFavorite: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockPrivateView: WorkItemViewItem = {
    id: 'private-view-1',
    name: 'My Secret Review',
    description: 'Personal filter',
    query: { assigneeId: userId },
    filters: { assigneeId: userId },
    displayFilters: { layout: 'list' },
    displayProperties: { assignee: true },
    richFilters: {},
    access: ViewAccess.private,
    sortOrder: 65535,
    logoProps: {},
    isLocked: false,
    projectId,
    createdById: userId,
    isFavorite: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockLockedView: WorkItemViewItem = {
    id: 'locked-view-1',
    name: 'Official Team Board',
    description: 'Locked view',
    query: { columnId: 'todo' },
    filters: { columnId: 'todo' },
    displayFilters: { layout: 'board' },
    displayProperties: { state: true },
    richFilters: {},
    access: ViewAccess.public,
    sortOrder: 65535,
    logoProps: {},
    isLocked: true,
    projectId,
    createdById: otherUserId,
    isFavorite: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    mockRepo = {
      findProjectViews: jest.fn(),
      findById: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      toggleFavorite: jest.fn(),
      favorite: jest.fn(),
      unfavorite: jest.fn(),
      isFavorite: jest.fn(),
      findUserFavoriteViews: jest.fn(),
    };

    mockEventEmitter = {
      emit: jest.fn(),
    };

    mockWorkItemService = {
      getProjectTasks: jest.fn(),
    };

    service = new ViewService(
      mockRepo as unknown as ViewRepository,
      mockEventEmitter as unknown as EventEmitter2,
      mockWorkItemService as unknown as WorkItemService,
    );
  });

  describe('getViews', () => {
    it('should return all visible project views for the user', async () => {
      mockRepo.findProjectViews.mockResolvedValue([mockPublicView, mockPrivateView]);

      const result = await service.getViews(projectId, userId);
      expect(result).toHaveLength(2);
      expect(mockRepo.findProjectViews).toHaveBeenCalledWith(projectId, userId, undefined);
    });

    it('should forward search query to repository', async () => {
      mockRepo.findProjectViews.mockResolvedValue([mockPublicView]);

      await service.getViews(projectId, userId, { search: 'Sprint' });
      expect(mockRepo.findProjectViews).toHaveBeenCalledWith(
        projectId,
        userId,
        { search: 'Sprint' },
      );
    });
  });

  describe('getView', () => {
    it('should return a public view to any project member', async () => {
      mockRepo.findById.mockResolvedValue(mockPublicView);

      const view = await service.getView(projectId, viewId, otherUserId, 'viewer');
      expect(view.id).toBe(viewId);
      expect(mockRepo.findById).toHaveBeenCalledWith(viewId, otherUserId);
    });

    it('should return a private view to its author', async () => {
      mockRepo.findById.mockResolvedValue(mockPrivateView);

      const view = await service.getView(projectId, 'private-view-1', userId, 'contributor');
      expect(view.id).toBe('private-view-1');
    });

    it('should return a private view to a project admin', async () => {
      mockRepo.findById.mockResolvedValue(mockPrivateView);

      const view = await service.getView(projectId, 'private-view-1', otherUserId, 'admin');
      expect(view.id).toBe('private-view-1');
    });

    it('should reject non-author, non-admin from accessing private view with ForbiddenException', async () => {
      mockRepo.findById.mockResolvedValue(mockPrivateView);

      await expect(
        service.getView(projectId, 'private-view-1', otherUserId, 'contributor'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw NotFoundException if view is not found or in different project', async () => {
      mockRepo.findById.mockResolvedValue(null);

      await expect(
        service.getView(projectId, 'unknown-view', userId),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('createView', () => {
    it('should create a saved view and emit event', async () => {
      const dto = {
        name: 'New Custom Board',
        description: 'Custom view',
        query: { priority: 'high' },
        displayFilters: { layout: 'board' as const },
        access: ViewAccess.public,
      };

      mockRepo.create.mockResolvedValue({
        ...mockPublicView,
        name: dto.name,
      });

      const result = await service.createView(projectId, userId, dto);
      expect(result.name).toBe('New Custom Board');
      expect(mockRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: dto.name,
          description: dto.description,
          query: dto.query,
          filters: dto.query,
          displayFilters: dto.displayFilters,
          access: dto.access,
          projectId,
          createdById: userId,
        }),
      );
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'work-item.view.created',
        expect.objectContaining({
          projectId,
          actorId: userId,
          name: dto.name,
        }),
      );
    });
  });

  describe('updateView', () => {
    it('should successfully update view and emit event', async () => {
      mockRepo.findById.mockResolvedValue(mockPublicView);
      mockRepo.update.mockResolvedValue({
        ...mockPublicView,
        name: 'Updated Name',
      });

      const updated = await service.updateView(
        projectId,
        viewId,
        userId,
        { name: 'Updated Name' },
        'contributor',
      );

      expect(updated.name).toBe('Updated Name');
      expect(mockRepo.update).toHaveBeenCalledWith(viewId, { name: 'Updated Name' }, userId);
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'work-item.view.updated',
        expect.objectContaining({
          viewId,
          projectId,
          actorId: userId,
        }),
      );
    });

    it('should reject update if view is locked and user is not author or admin', async () => {
      mockRepo.findById.mockResolvedValue(mockLockedView);

      await expect(
        service.updateView(
          projectId,
          'locked-view-1',
          userId,
          { name: 'Hacked Name' },
          'contributor',
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should allow admin to update locked view', async () => {
      mockRepo.findById.mockResolvedValue(mockLockedView);
      mockRepo.update.mockResolvedValue({
        ...mockLockedView,
        name: 'Admin Updated',
      });

      const result = await service.updateView(
        projectId,
        'locked-view-1',
        userId,
        { name: 'Admin Updated' },
        'admin',
      );

      expect(result.name).toBe('Admin Updated');
    });

    it('should reject updating another user private view', async () => {
      mockRepo.findById.mockResolvedValue(mockPrivateView);

      await expect(
        service.updateView(
          projectId,
          'private-view-1',
          otherUserId,
          { name: 'Sneak Change' },
          'contributor',
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('deleteView', () => {
    it('should allow author to delete view', async () => {
      mockRepo.findById.mockResolvedValue(mockPublicView);
      mockRepo.delete.mockResolvedValue(true);

      const res = await service.deleteView(projectId, viewId, userId, 'contributor');
      expect(res.success).toBe(true);
      expect(mockRepo.delete).toHaveBeenCalledWith(viewId);
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'work-item.view.deleted',
        expect.objectContaining({
          viewId,
          projectId,
          actorId: userId,
        }),
      );
    });

    it('should allow admin to delete view created by another user', async () => {
      mockRepo.findById.mockResolvedValue(mockPublicView);
      mockRepo.delete.mockResolvedValue(true);

      const res = await service.deleteView(projectId, viewId, otherUserId, 'admin');
      expect(res.success).toBe(true);
    });

    it('should reject non-author, non-admin from deleting view', async () => {
      mockRepo.findById.mockResolvedValue(mockPublicView);

      await expect(
        service.deleteView(projectId, viewId, otherUserId, 'contributor'),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('toggleFavorite, favorite & unfavorite', () => {
    it('should toggle favorite status for the user', async () => {
      mockRepo.findById.mockResolvedValue(mockPublicView);
      mockRepo.toggleFavorite.mockResolvedValue({ isFavorite: true });

      const res = await service.toggleFavorite(projectId, viewId, userId, 'contributor');
      expect(res).toEqual({ isFavorite: true });
      expect(mockRepo.toggleFavorite).toHaveBeenCalledWith(viewId, userId);
    });

    it('should explicitly favorite a view (Plane.so parity)', async () => {
      mockRepo.findById.mockResolvedValue(mockPublicView);
      mockRepo.favorite.mockResolvedValue(true);

      const res = await service.favorite(projectId, viewId, userId, 'contributor');
      expect(res).toEqual({ isFavorite: true });
      expect(mockRepo.favorite).toHaveBeenCalledWith(viewId, userId);
    });

    it('should explicitly unfavorite a view (Plane.so parity)', async () => {
      mockRepo.findById.mockResolvedValue(mockPublicView);
      mockRepo.unfavorite.mockResolvedValue(true);

      const res = await service.unfavorite(projectId, viewId, userId, 'contributor');
      expect(res).toEqual({ isFavorite: false });
      expect(mockRepo.unfavorite).toHaveBeenCalledWith(viewId, userId);
    });
  });

  describe('Plane.so aliases compatibility', () => {
    it('should support filters and displayProperties aliases on create', async () => {
      mockRepo.create.mockResolvedValue(mockPublicView);

      await service.createView(projectId, userId, {
        name: 'Plane Style View',
        filters: { state: 'started' },
        displayProperties: { assignee: true, key: true },
      });

      expect(mockRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Plane Style View',
          filters: { state: 'started' },
          query: { state: 'started' },
          displayProperties: { assignee: true, key: true },
        }),
      );
    });

    it('should support getFavoriteViews', async () => {
      mockRepo.findUserFavoriteViews = jest.fn().mockResolvedValue([
        { id: 'fav-1', viewId: mockPublicView.id, view: mockPublicView },
      ]);

      const favs = await service.getFavoriteViews(projectId, userId);
      expect(favs).toHaveLength(1);
      expect(mockRepo.findUserFavoriteViews).toHaveBeenCalledWith(projectId, userId);
    });
  });


  describe('getViewWorkItems', () => {
    it('should apply view query filters to getProjectTasks', async () => {
      mockRepo.findById.mockResolvedValue(mockPublicView);
      mockWorkItemService.getProjectTasks.mockResolvedValue([
        { id: 'task-1', title: 'Urgent Bug 1' },
      ]);

      const tasks = await service.getViewWorkItems(
        projectId,
        viewId,
        userId,
        'viewer',
      );

      expect(tasks).toHaveLength(1);
      expect(mockWorkItemService.getProjectTasks).toHaveBeenCalledWith(
        projectId,
        expect.objectContaining({
          priority: ['urgent', 'high'],
        }),
      );
    });

    it('should allow runtime extraQuery parameters to merge with view filters', async () => {
      mockRepo.findById.mockResolvedValue(mockPublicView);
      mockWorkItemService.getProjectTasks.mockResolvedValue([]);

      await service.getViewWorkItems(
        projectId,
        viewId,
        userId,
        'viewer',
        { search: 'Login issue' } as any,
      );

      expect(mockWorkItemService.getProjectTasks).toHaveBeenCalledWith(
        projectId,
        expect.objectContaining({
          priority: ['urgent', 'high'],
          search: 'Login issue',
        }),
      );
    });
  });
});
