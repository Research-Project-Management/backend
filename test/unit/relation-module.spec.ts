import {
  RelationService,
  INVERSE_RELATION_MAP,
} from '@/modules/work-item/relation/relation.service';
import { RelationRepository } from '@/modules/work-item/relation/relation.repository';
import { RelationController } from '@/modules/work-item/relation/relation.controller';
import {
  Task,
  TaskPriority,
  TaskRecurrence,
  TaskReminder,
} from '@prisma/client';
import { NotFoundException, BadRequestException } from '@nestjs/common';

describe('Relation Module (Work Item Dependencies & Bidirectional Linking)', () => {
  let relationService: RelationService;
  let mockRelationRepo: any;
  let mockPrisma: any;
  let mockEventEmitter: { emit: jest.Mock };
  let mockCache: { del: jest.Mock };

  const projectId = '00000000-0000-0000-0000-000000000001';
  const taskAId = '00000000-0000-0000-0000-000000000010';
  const taskBId = '00000000-0000-0000-0000-000000000020';
  const userId = '00000000-0000-0000-0000-000000000099';

  const baseTaskA: any = {
    id: taskAId,
    identifier: 'FLUX-1',
    sequenceNumber: 1,
    title: 'Task A (Auth module)',
    content: '',
    description: '',
    columnId: 'todo',
    rank: 1,
    priority: TaskPriority.high,
    recurrence: TaskRecurrence.none,
    reminder: TaskReminder.none,
    archivedAt: null,
    labels: [],
    completed: false,
    relations: [],
    startDate: null,
    dueDate: null,
    projectId,
    authorId: userId,
    assigneeId: null,
    cycleId: null,
    parentTaskId: null,
    timeSpent: 0,
    assigneeIds: [],
    updates: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };

  const baseTaskB: any = {
    ...baseTaskA,
    id: taskBId,
    identifier: 'FLUX-2',
    sequenceNumber: 2,
    title: 'Task B (User dashboard)',
    priority: TaskPriority.medium,
    relations: [],
  };

  beforeEach(() => {
    mockPrisma = {
      task: {
        update: jest
          .fn()
          .mockImplementation(({ data }) =>
            Promise.resolve({ ...baseTaskA, ...data }),
          ),
      },
      $transaction: jest.fn().mockImplementation((ops) => Promise.all(ops)),
    };

    mockRelationRepo = {
      prisma: mockPrisma,
      findTask: jest.fn(),
      findTasksByIds: jest.fn(),
      updateTaskRelations: jest.fn(),
      executeTransaction: jest
        .fn()
        .mockImplementation((ops) => Promise.all(ops)),
    };

    mockEventEmitter = { emit: jest.fn() };
    mockCache = { del: jest.fn().mockResolvedValue(true) };

    relationService = new RelationService(
      mockRelationRepo,
      mockEventEmitter as any,
      mockCache as any,
    );
  });

  describe('Inverse Relation Mapping', () => {
    it('should map blocks to blocked_by and vice-versa', () => {
      expect(INVERSE_RELATION_MAP.blocks).toBe('blocked_by');
      expect(INVERSE_RELATION_MAP.blocked_by).toBe('blocks');
    });

    it('should map duplicate_of to duplicated_by and vice-versa', () => {
      expect(INVERSE_RELATION_MAP.duplicate_of).toBe('duplicated_by');
      expect(INVERSE_RELATION_MAP.duplicated_by).toBe('duplicate_of');
    });

    it('should map relates_to symmetrically to relates_to', () => {
      expect(INVERSE_RELATION_MAP.relates_to).toBe('relates_to');
    });
  });

  describe('Add Relation', () => {
    it('should add bidirectional blocks / blocked_by relation between two tasks', async () => {
      mockRelationRepo.findTask!.mockImplementation((id: string) => {
        if (id === taskAId) return Promise.resolve({ ...baseTaskA });
        if (id === taskBId) return Promise.resolve({ ...baseTaskB });
        return Promise.resolve(null);
      });

      const result = await relationService.addRelation(
        taskAId,
        {
          targetTaskId: taskBId,
          type: 'blocks',
        },
        userId,
      );

      expect(result.success).toBe(true);
      expect(mockRelationRepo.executeTransaction).toHaveBeenCalled();
      expect(mockPrisma.task.update).toHaveBeenCalledTimes(2);

      // Verify task A gets "blocks"
      expect(mockPrisma.task.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: taskAId },
          data: {
            relations: expect.arrayContaining([
              expect.objectContaining({
                targetTaskId: taskBId,
                type: 'blocks',
              }),
            ]),
          },
        }),
      );

      // Verify task B gets "blocked_by"
      expect(mockPrisma.task.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: taskBId },
          data: {
            relations: expect.arrayContaining([
              expect.objectContaining({
                targetTaskId: taskAId,
                type: 'blocked_by',
              }),
            ]),
          },
        }),
      );

      // Verify cache invalidation
      expect(mockCache.del).toHaveBeenCalled();
      // Verify event emission
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'task.relation.added',
        expect.objectContaining({
          sourceTaskId: taskAId,
          targetTaskId: taskBId,
          type: 'blocks',
          actorId: userId,
        }),
      );
    });

    it('should reject linking a task to itself', async () => {
      mockRelationRepo.findTask!.mockResolvedValue({ ...baseTaskA });

      await expect(
        relationService.addRelation(taskAId, {
          targetTaskId: taskAId,
          type: 'relates_to',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw NotFoundException if source task does not exist', async () => {
      mockRelationRepo.findTask!.mockResolvedValue(null);

      await expect(
        relationService.addRelation('non-existent', {
          targetTaskId: taskBId,
          type: 'relates_to',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException if target task does not exist', async () => {
      mockRelationRepo.findTask!.mockImplementation((id: string) => {
        if (id === taskAId) return Promise.resolve({ ...baseTaskA });
        return Promise.resolve(null);
      });

      await expect(
        relationService.addRelation(taskAId, {
          targetTaskId: 'non-existent',
          type: 'relates_to',
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('Remove Relation', () => {
    it('should remove bidirectional relation atomically from both tasks', async () => {
      const existingTaskA = {
        ...baseTaskA,
        relations: [
          {
            targetTaskId: taskBId,
            type: 'blocks',
            createdAt: new Date().toISOString(),
          },
        ],
      };
      const existingTaskB = {
        ...baseTaskB,
        relations: [
          {
            targetTaskId: taskAId,
            type: 'blocked_by',
            createdAt: new Date().toISOString(),
          },
        ],
      };

      mockRelationRepo.findTask!.mockImplementation((id: string) => {
        if (id === taskAId) return Promise.resolve(existingTaskA as any);
        if (id === taskBId) return Promise.resolve(existingTaskB as any);
        return Promise.resolve(null);
      });

      const result = await relationService.removeRelation(
        taskAId,
        taskBId,
        userId,
      );

      expect(result.success).toBe(true);
      expect(mockRelationRepo.executeTransaction).toHaveBeenCalled();
      expect(mockPrisma.task.update).toHaveBeenCalledTimes(2);

      // Verify task A has relations filtered
      expect(mockPrisma.task.update).toHaveBeenCalledWith({
        where: { id: taskAId },
        data: { relations: [] },
      });

      // Verify task B has relations filtered
      expect(mockPrisma.task.update).toHaveBeenCalledWith({
        where: { id: taskBId },
        data: { relations: [] },
      });

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'task.relation.removed',
        expect.objectContaining({
          sourceTaskId: taskAId,
          targetTaskId: taskBId,
        }),
      );
    });

    it('should throw NotFoundException if source task not found on removal', async () => {
      mockRelationRepo.findTask!.mockResolvedValue(null);

      await expect(
        relationService.removeRelation('non-existent', taskBId),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('Get Task Relations with Target Hydration', () => {
    it('should return empty array if task has no relations', async () => {
      mockRelationRepo.findTask!.mockResolvedValue({
        ...baseTaskA,
        relations: [],
      });

      const result = await relationService.getTaskRelations(taskAId);
      expect(result.relations).toEqual([]);
    });

    it('should enrich relations with target task metadata', async () => {
      const taskWithRelations = {
        ...baseTaskA,
        relations: [
          {
            targetTaskId: taskBId,
            type: 'blocks',
            createdAt: '2026-09-11T12:00:00.000Z',
          },
        ],
      };
      mockRelationRepo.findTask!.mockResolvedValue(taskWithRelations as any);
      mockRelationRepo.findTasksByIds!.mockResolvedValue([{ ...baseTaskB }]);

      const result = await relationService.getTaskRelations(taskAId);
      expect(result.relations).toHaveLength(1);
      expect(result.relations[0].targetTaskId).toBe(taskBId);
      expect(result.relations[0].type).toBe('blocks');
      expect(result.relations[0].targetTask).toBeDefined();
      expect(result.relations[0].targetTask?.title).toBe(
        'Task B (User dashboard)',
      );
      expect(result.relations[0].targetTask?.identifier).toBe('FLUX-2');
    });
  });

  describe('RelationController Delegation to RelationService', () => {
    it('should delegate addRelation and removeRelation through RelationController', async () => {
      const relationController = new RelationController(relationService);

      jest
        .spyOn(relationService, 'addRelation')
        .mockResolvedValue({ success: true, message: 'ok', relations: [] });
      jest
        .spyOn(relationService, 'removeRelation')
        .mockResolvedValue({ success: true, message: 'removed' });

      await relationController.addRelation(
        taskAId,
        { targetTaskId: taskBId, type: 'relates_to' },
        userId,
      );
      expect(relationService.addRelation).toHaveBeenCalledWith(
        taskAId,
        { targetTaskId: taskBId, type: 'relates_to' },
        userId,
      );

      await relationController.removeRelation(taskAId, taskBId, userId);
      expect(relationService.removeRelation).toHaveBeenCalledWith(
        taskAId,
        taskBId,
        userId,
      );
    });
  });
});
