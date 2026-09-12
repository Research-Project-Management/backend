import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { CycleService } from '@/modules/work-item/cycle/cycle.service';
import { CycleRepository } from '@/modules/work-item/cycle/cycle.repository';
import {
  IncompleteTaskAction,
  CycleTaskItem,
} from '@/modules/work-item/cycle/types/cycle.types';
import { calculateCycleStats } from '@/modules/work-item/cycle/utils/cycle.util';
import { CycleStatus, CyclePhase } from '@prisma/client';

describe('Cycle Module', () => {
  let service: CycleService;
  let mockCycleRepo: Partial<jest.Mocked<CycleRepository>>;
  let mockEventEmitter: any;
  let mockCache: any;

  const mockProjectId = '11111111-1111-1111-1111-111111111111';
  const mockUserId = '22222222-2222-2222-2222-222222222222';
  const mockCycleId = '33333333-3333-3333-3333-333333333333';

  beforeEach(() => {
    mockCycleRepo = {
      findProjectCycles: jest.fn(),
      findActiveCycle: jest.fn().mockResolvedValue(null),
      findCycleById: jest.fn(),
      findOverlappingCycle: jest.fn().mockResolvedValue(null),
      createCycle: jest.fn(),
      updateCycle: jest.fn(),
      softDeleteCycle: jest.fn(),
      restoreCycle: jest.fn(),
      deleteCycle: jest.fn(),
      findCycleTasks: jest.fn(),
      transferIncompleteTasks: jest.fn().mockResolvedValue({ count: 2 }),
      addTaskToCycle: jest.fn(),
      removeTaskFromCycle: jest.fn(),
      addTasksBatch: jest.fn().mockResolvedValue({ count: 3 }),
      findCyclesEligibleForAutoStart: jest.fn().mockResolvedValue([]),
      findCyclesEligibleForAutoComplete: jest.fn().mockResolvedValue([]),
      hasActiveCycle: jest.fn().mockResolvedValue(false),
    };

    mockEventEmitter = {
      emit: jest.fn(),
    };

    mockCache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
    };

    service = new CycleService(
      mockCycleRepo as unknown as CycleRepository,
      mockEventEmitter,
      mockCache,
    );
  });

  describe('calculateCycleStats (State Groups)', () => {
    it('should accurately aggregate tasks across state groups and calculate percentage and points', () => {
      const tasks: Array<
        Partial<CycleTaskItem> & {
          columnId?: string;
          completed?: boolean;
        }
      > = [
        { id: '1', columnId: 'done', completed: true },
        { id: '2', columnId: 'in-progress', completed: false },
        { id: '3', columnId: 'todo', completed: false },
        { id: '4', columnId: 'backlog', completed: false },
        { id: '5', columnId: 'cancelled', completed: false },
      ];

      const stats = calculateCycleStats(tasks);

      expect(stats.totalTasks).toBe(5);
      expect(stats.completedTasks).toBe(1);
      expect(stats.startedTasks).toBe(1);
      expect(stats.unstartedTasks).toBe(1);
      expect(stats.backlogTasks).toBe(1);
      expect(stats.cancelledTasks).toBe(1);
      expect(stats.completionPercentage).toBe(20); // 1 / 5 = 20%
    });

    it('should return 0 percentage when tasks array is empty', () => {
      const stats = calculateCycleStats([]);
      expect(stats.totalTasks).toBe(0);
      expect(stats.completedTasks).toBe(0);
      expect(stats.completionPercentage).toBe(0);
    });
  });

  describe('createCycle', () => {
    it('should successfully create a planned cycle with valid dates', async () => {
      const startDate = new Date('2026-09-01T00:00:00Z');
      const endDate = new Date('2026-09-14T23:59:59Z');

      (mockCycleRepo.createCycle as jest.Mock).mockImplementation((data) =>
        Promise.resolve({ id: mockCycleId, ...data }),
      );

      const result = await service.createCycle(mockProjectId, mockUserId, {
        name: 'Sprint 1',
        description: 'First sprint of project',
        startDate,
        endDate,
        status: CycleStatus.planned,
      });

      expect(result.cycle).toBeDefined();
      expect(result.cycle.name).toBe('Sprint 1');
      expect(mockCycleRepo.createCycle).toHaveBeenCalled();
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'cycle.created',
        expect.anything(),
      );
    });

    it('should reject if startDate is after endDate with BadRequestException', async () => {
      await expect(
        service.createCycle(mockProjectId, mockUserId, {
          name: 'Invalid Dates Cycle',
          startDate: new Date('2026-09-20'),
          endDate: new Date('2026-09-10'),
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject if dates overlap with an existing planned/active cycle in the project', async () => {
      (mockCycleRepo.findOverlappingCycle as jest.Mock).mockResolvedValue({
        id: 'existing-cycle',
        name: 'Sprint 0',
      });

      await expect(
        service.createCycle(mockProjectId, mockUserId, {
          name: 'Overlapping Sprint',
          startDate: new Date('2026-09-05'),
          endDate: new Date('2026-09-15'),
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('should enforce Single Active Cycle invariant: reject creating active cycle if one is already active', async () => {
      (mockCycleRepo.findActiveCycle as jest.Mock).mockResolvedValue({
        id: 'currently-active-cycle',
        name: 'Sprint Ongoing',
        status: CycleStatus.active,
      });

      await expect(
        service.createCycle(mockProjectId, mockUserId, {
          name: 'Second Active Sprint',
          status: CycleStatus.active,
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('updateCycle', () => {
    it('should successfully update cycle properties', async () => {
      (mockCycleRepo.findCycleById as jest.Mock).mockResolvedValue({
        id: mockCycleId,
        projectId: mockProjectId,
        name: 'Old Name',
        status: CycleStatus.planned,
      });
      (mockCycleRepo.updateCycle as jest.Mock).mockImplementation((id, data) =>
        Promise.resolve({ id, ...data }),
      );

      const result = await service.updateCycle(mockCycleId, {
        name: 'New Name',
        description: 'Updated description',
      });

      expect(result.cycle.name).toBe('New Name');
      expect(mockCycleRepo.updateCycle).toHaveBeenCalled();
    });

    it('should reject transition to active status if another cycle is already active', async () => {
      (mockCycleRepo.findCycleById as jest.Mock).mockResolvedValue({
        id: mockCycleId,
        projectId: mockProjectId,
        status: CycleStatus.planned,
      });
      (mockCycleRepo.findActiveCycle as jest.Mock).mockResolvedValue({
        id: 'other-active-cycle',
        name: 'Current Sprint',
      });

      await expect(
        service.updateCycle(mockCycleId, {
          status: CycleStatus.active,
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('getCycleProgress', () => {
    it('should retrieve tasks and calculate progress stats', async () => {
      (mockCycleRepo.findCycleById as jest.Mock).mockResolvedValue({
        id: mockCycleId,
      });
      (mockCycleRepo.findCycleTasks as jest.Mock).mockResolvedValue([
        { id: 't1', columnId: 'done', completed: true },
        { id: 't2', columnId: 'todo', completed: false },
      ]);

      const result = await service.getCycleProgress(mockCycleId);

      expect(result.progress.totalTasks).toBe(2);
      expect(result.progress.completedTasks).toBe(1);
      expect(result.progress.completionPercentage).toBe(50);
    });
  });

  describe('addTask & addTasksBatch', () => {
    it('should add single task to cycle and invalidate cache', async () => {
      (mockCycleRepo.findCycleById as jest.Mock).mockResolvedValue({
        id: mockCycleId,
        projectId: mockProjectId,
      });
      (mockCycleRepo.addTaskToCycle as jest.Mock).mockResolvedValue({
        id: 'task-1',
        cycleId: mockCycleId,
      });

      const result = await service.addTask(mockCycleId, 'task-1');

      expect(result.message).toContain('added to cycle');
      expect(mockCycleRepo.addTaskToCycle).toHaveBeenCalledWith(
        'task-1',
        mockCycleId,
      );
      expect(mockCache.del).toHaveBeenCalled();
    });

    it('should batch add tasks to cycle', async () => {
      (mockCycleRepo.findCycleById as jest.Mock).mockResolvedValue({
        id: mockCycleId,
        projectId: mockProjectId,
      });

      const result = await service.addTasksBatch(mockCycleId, [
        't1',
        't2',
        't3',
      ]);

      expect(result.count).toBe(3);
      expect(mockCycleRepo.addTasksBatch).toHaveBeenCalledWith(
        ['t1', 't2', 't3'],
        mockCycleId,
      );
    });
  });

  describe('completeCycle & Rollover', () => {
    it('should complete cycle and transfer incomplete tasks to next cycle', async () => {
      const nextCycleId = 'next-cycle-uuid';
      (mockCycleRepo.findCycleById as jest.Mock).mockImplementation((id) => {
        if (id === mockCycleId) {
          return Promise.resolve({
            id: mockCycleId,
            projectId: mockProjectId,
            status: CycleStatus.active,
          });
        }
        if (id === nextCycleId) {
          return Promise.resolve({
            id: nextCycleId,
            projectId: mockProjectId,
            status: CycleStatus.planned,
          });
        }
        return Promise.resolve(null);
      });

      (mockCycleRepo.findCycleTasks as jest.Mock).mockResolvedValue([
        { id: 't1', columnId: 'done', completed: true },
        { id: 't2', columnId: 'in-progress', completed: false },
        { id: 't3', columnId: 'todo', completed: false },
      ]);

      (mockCycleRepo.updateCycle as jest.Mock).mockImplementation((id, data) =>
        Promise.resolve({ id, ...data }),
      );

      const result = await service.completeCycle(mockCycleId, {
        action: IncompleteTaskAction.transfer,
        targetCycleId: nextCycleId,
      });

      expect(result.message).toContain('completed successfully');
      expect(mockCycleRepo.transferIncompleteTasks).toHaveBeenCalledWith(
        mockCycleId,
        nextCycleId,
        ['t2', 't3'],
      );
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'cycle.completed',
        expect.anything(),
      );
    });

    it('should complete cycle and move incomplete tasks to backlog', async () => {
      (mockCycleRepo.findCycleById as jest.Mock).mockResolvedValue({
        id: mockCycleId,
        projectId: mockProjectId,
        status: CycleStatus.active,
      });

      (mockCycleRepo.findCycleTasks as jest.Mock).mockResolvedValue([
        { id: 't1', columnId: 'done', completed: true },
        { id: 't2', columnId: 'todo', completed: false },
      ]);

      (mockCycleRepo.updateCycle as jest.Mock).mockImplementation((id, data) =>
        Promise.resolve({ id, ...data }),
      );

      const result = await service.completeCycle(mockCycleId, {
        action: IncompleteTaskAction.backlog,
      });

      expect(result.message).toContain('completed successfully');
      expect(mockCycleRepo.transferIncompleteTasks).toHaveBeenCalledWith(
        mockCycleId,
        null,
        ['t2'],
      );
    });

    it('should reject transfer if target cycle is the same cycle', async () => {
      (mockCycleRepo.findCycleById as jest.Mock).mockResolvedValue({
        id: mockCycleId,
        projectId: mockProjectId,
      });

      await expect(
        service.completeCycle(mockCycleId, {
          action: IncompleteTaskAction.transfer,
          targetCycleId: mockCycleId,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('softDeleteCycle and restoreCycle', () => {
    it('should soft delete cycle and clear cache', async () => {
      (mockCycleRepo.findCycleById as jest.Mock).mockResolvedValue({
        id: mockCycleId,
        projectId: mockProjectId,
      });

      const result = await service.deleteCycle(mockCycleId);

      expect(result.message).toContain('soft-deleted successfully');
      expect(mockCycleRepo.softDeleteCycle).toHaveBeenCalledWith(mockCycleId);
      expect(mockCache.del).toHaveBeenCalled();
    });

    it('should restore a soft-deleted cycle', async () => {
      (mockCycleRepo.restoreCycle as jest.Mock).mockResolvedValue({
        id: mockCycleId,
        projectId: mockProjectId,
        deletedAt: null,
      });

      const result = await service.restoreCycle(mockCycleId);

      expect(result.message).toContain('restored successfully');
      expect(mockCycleRepo.restoreCycle).toHaveBeenCalledWith(mockCycleId);
    });
  });
});
