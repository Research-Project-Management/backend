import { UpdateService } from '@/modules/work-item/update/update.service';
import { PrismaService } from '@/core/database/prisma.service';
import { WorkItemUpdateStatus } from '@/modules/work-item/update/dto/update.dto';
import { NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

describe('Update Module', () => {
  let service: UpdateService;
  let mockPrisma: {
    task: {
      findUnique: jest.Mock;
      update: jest.Mock;
    };
  };
  let mockEventEmitter: { emit: jest.Mock };

  const taskId = 'task-1';
  const authorId = 'user-1';
  const projectId = 'proj-1';

  beforeEach(() => {
    mockPrisma = {
      task: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    mockEventEmitter = {
      emit: jest.fn(),
    };
    service = new UpdateService(
      mockPrisma as unknown as PrismaService,
      undefined,
      mockEventEmitter as unknown as EventEmitter2,
    );
  });

  describe('getUpdates', () => {
    it('should throw NotFoundException if task not found', async () => {
      mockPrisma.task.findUnique.mockResolvedValue(null);
      await expect(service.getUpdates(taskId)).rejects.toThrow(NotFoundException);
    });

    it('should return sorted updates newest first', async () => {
      mockPrisma.task.findUnique.mockResolvedValue({
        id: taskId,
        updates: [
          { id: 'u1', createdAt: '2026-01-01T00:00:00.000Z', status: WorkItemUpdateStatus.ON_TRACK },
          { id: 'u2', createdAt: '2026-01-02T00:00:00.000Z', status: WorkItemUpdateStatus.AT_RISK },
        ],
      });

      const result = await service.getUpdates(taskId);
      expect(result.updates).toHaveLength(2);
      expect(result.updates[0].id).toBe('u2');
      expect(result.updates[1].id).toBe('u1');
    });
  });

  describe('addUpdate', () => {
    it('should throw NotFoundException if task not found', async () => {
      mockPrisma.task.findUnique.mockResolvedValue(null);
      await expect(
        service.addUpdate(taskId, authorId, { status: WorkItemUpdateStatus.ON_TRACK }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should append new status update and emit event', async () => {
      mockPrisma.task.findUnique.mockResolvedValue({
        id: taskId,
        projectId,
        updates: [],
      });
      mockPrisma.task.update.mockResolvedValue({});

      const result = await service.addUpdate(taskId, authorId, {
        status: WorkItemUpdateStatus.ON_TRACK,
        comment: 'Going well',
      });

      expect(result.update.status).toBe(WorkItemUpdateStatus.ON_TRACK);
      expect(result.update.comment).toBe('Going well');
      expect(result.updates).toHaveLength(1);
      expect(mockPrisma.task.update).toHaveBeenCalled();
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'task.update.added',
        expect.objectContaining({ taskId, status: WorkItemUpdateStatus.ON_TRACK }),
      );
    });
  });

  describe('deleteUpdate', () => {
    it('should throw NotFoundException if update not found', async () => {
      mockPrisma.task.findUnique.mockResolvedValue({
        id: taskId,
        projectId,
        updates: [{ id: 'u-other' }],
      });

      await expect(service.deleteUpdate(taskId, 'u-missing', authorId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should delete update and return updated list', async () => {
      mockPrisma.task.findUnique.mockResolvedValue({
        id: taskId,
        projectId,
        updates: [
          { id: 'u1', createdAt: '2026-01-01' },
          { id: 'u2', createdAt: '2026-01-02' },
        ],
      });
      mockPrisma.task.update.mockResolvedValue({});

      const result = await service.deleteUpdate(taskId, 'u1', authorId);
      expect(result.success).toBe(true);
      expect(result.updates).toHaveLength(1);
      expect(result.updates[0].id).toBe('u2');
    });
  });

  describe('getLatestUpdate', () => {
    it('should return null if no updates exist', async () => {
      mockPrisma.task.findUnique.mockResolvedValue({
        id: taskId,
        updates: [],
      });

      const result = await service.getLatestUpdate(taskId);
      expect(result.update).toBeNull();
    });

    it('should return most recent update', async () => {
      mockPrisma.task.findUnique.mockResolvedValue({
        id: taskId,
        updates: [
          { id: 'u1', createdAt: '2026-01-01T00:00:00.000Z' },
          { id: 'u2', createdAt: '2026-01-02T00:00:00.000Z' },
        ],
      });

      const result = await service.getLatestUpdate(taskId);
      expect(result.update?.id).toBe('u2');
    });
  });
});
