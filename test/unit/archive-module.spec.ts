import { ArchiveService } from '@/modules/work-item/archive/archive.service';
import { ArchiveRepository } from '@/modules/work-item/archive/archive.repository';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

describe('Archive Module', () => {
  let service: ArchiveService;
  let mockRepo: {
    findTaskWithProject: jest.Mock;
    archiveTask: jest.Mock;
    restoreTask: jest.Mock;
    findTasksByIds: jest.Mock;
    bulkArchive: jest.Mock;
    bulkRestore: jest.Mock;
    findArchivedTasks: jest.Mock;
  };
  let mockEventEmitter: { emit: jest.Mock };

  const taskId = 'task-1';
  const userId = 'user-1';
  const projectId = 'project-1';

  beforeEach(() => {
    mockRepo = {
      findTaskWithProject: jest.fn(),
      archiveTask: jest.fn(),
      restoreTask: jest.fn(),
      findTasksByIds: jest.fn(),
      bulkArchive: jest.fn(),
      bulkRestore: jest.fn(),
      findArchivedTasks: jest.fn(),
    };
    mockEventEmitter = {
      emit: jest.fn(),
    };
    service = new ArchiveService(
      mockRepo as unknown as ArchiveRepository,
      mockEventEmitter as unknown as EventEmitter2,
    );
  });

  describe('archiveWorkItem', () => {
    it('should throw NotFoundException if task not found', async () => {
      mockRepo.findTaskWithProject.mockResolvedValue(null);
      await expect(service.archiveWorkItem(taskId, userId)).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if task is already archived', async () => {
      mockRepo.findTaskWithProject.mockResolvedValue({
        id: taskId,
        archivedAt: new Date(),
        identifier: 'FLUX-1',
      });
      await expect(service.archiveWorkItem(taskId, userId)).rejects.toThrow(BadRequestException);
    });

    it('should archive task and emit events', async () => {
      const mockTask = {
        id: taskId,
        identifier: 'FLUX-1',
        projectId,
        archivedAt: null,
        project: { workspaceId: 'ws-1' },
      };
      mockRepo.findTaskWithProject.mockResolvedValue(mockTask);
      mockRepo.archiveTask.mockResolvedValue({ ...mockTask, archivedAt: new Date() });

      const result = await service.archiveWorkItem(taskId, userId);
      expect(result.success).toBe(true);
      expect(mockRepo.archiveTask).toHaveBeenCalledWith(taskId);
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'work-item.archived',
        expect.objectContaining({ taskId, userId }),
      );
    });
  });

  describe('restoreWorkItem', () => {
    it('should throw NotFoundException if task not found', async () => {
      mockRepo.findTaskWithProject.mockResolvedValue(null);
      await expect(service.restoreWorkItem(taskId, userId)).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if task is not archived', async () => {
      mockRepo.findTaskWithProject.mockResolvedValue({
        id: taskId,
        archivedAt: null,
        identifier: 'FLUX-1',
      });
      await expect(service.restoreWorkItem(taskId, userId)).rejects.toThrow(BadRequestException);
    });

    it('should restore task and emit events', async () => {
      const mockTask = {
        id: taskId,
        identifier: 'FLUX-1',
        projectId,
        archivedAt: new Date(),
        project: { workspaceId: 'ws-1' },
      };
      mockRepo.findTaskWithProject.mockResolvedValue(mockTask);
      mockRepo.restoreTask.mockResolvedValue({ ...mockTask, archivedAt: null });

      const result = await service.restoreWorkItem(taskId, userId);
      expect(result.success).toBe(true);
      expect(mockRepo.restoreTask).toHaveBeenCalledWith(taskId);
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'work-item.restored',
        expect.objectContaining({ taskId, userId }),
      );
    });
  });

  describe('bulkArchiveWorkItems', () => {
    it('should throw BadRequestException if no tasks found', async () => {
      mockRepo.findTasksByIds.mockResolvedValue([]);
      await expect(
        service.bulkArchiveWorkItems({ taskIds: ['t-none'] }, userId),
      ).rejects.toThrow(BadRequestException);
    });

    it('should bulk archive tasks and return count', async () => {
      mockRepo.findTasksByIds.mockResolvedValue([{ id: 't1', projectId }]);
      mockRepo.bulkArchive.mockResolvedValue({ count: 1 });

      const result = await service.bulkArchiveWorkItems({ taskIds: ['t1'] }, userId);
      expect(result.success).toBe(true);
      expect(result.count).toBe(1);
    });
  });

  describe('bulkRestoreWorkItems', () => {
    it('should throw BadRequestException if no tasks found', async () => {
      mockRepo.findTasksByIds.mockResolvedValue([]);
      await expect(
        service.bulkRestoreWorkItems({ taskIds: ['t-none'] }, userId),
      ).rejects.toThrow(BadRequestException);
    });

    it('should bulk restore tasks and return count', async () => {
      mockRepo.findTasksByIds.mockResolvedValue([{ id: 't1', projectId }]);
      mockRepo.bulkRestore.mockResolvedValue({ count: 1 });

      const result = await service.bulkRestoreWorkItems({ taskIds: ['t1'] }, userId);
      expect(result.success).toBe(true);
      expect(result.count).toBe(1);
    });
  });

  describe('getArchivedWorkItems', () => {
    it('should query archived tasks for project', async () => {
      mockRepo.findArchivedTasks.mockResolvedValue({ tasks: [], total: 0 });
      const result = await service.getArchivedWorkItems(projectId, { page: 1, limit: 10 });
      expect(result.total).toBe(0);
      expect(mockRepo.findArchivedTasks).toHaveBeenCalledWith(projectId, { page: 1, limit: 10 });
    });
  });
});
