import { Test, TestingModule } from '@nestjs/testing';
import { WorkItemService } from '@/modules/work-item/work-item.service';
import { WorkItemRepository } from '@/modules/work-item/work-item.repository';
import { RedisCacheService } from '@/core/cache/redis-cache.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotFoundException } from '@nestjs/common';
import { TaskPriority } from '@prisma/client';

describe('WorkItemService', () => {
  let service: WorkItemService;
  let repo: jest.Mocked<WorkItemRepository>;
  let eventEmitter: EventEmitter2;
  let cache: jest.Mocked<RedisCacheService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkItemService,
        {
          provide: EventEmitter2,
          useValue: {
            emit: jest.fn(),
          },
        },
        {
          provide: RedisCacheService,
          useValue: {
            get: jest.fn(),
            set: jest.fn(),
            del: jest.fn(),
            wrap: jest.fn((key, fn) => fn()),
          },
        },
        {
          provide: WorkItemRepository,
          useValue: {
            findWorkspaceTasks: jest.fn(),
            findProjectTasks: jest.fn(),
            findProjectWithColumns: jest.fn().mockResolvedValue({
              id: 'proj-1',
              name: 'AI Project',
              taskColumns: [{ id: 'col-todo', title: 'To Do' }],
            }),
            findTaskById: jest.fn(),
            countColumnTasks: jest.fn().mockResolvedValue(0),
            nextProjectTaskIdentifier: jest.fn().mockResolvedValue({
              identifier: 'AI-1',
              sequenceNumber: 1,
            }),
            createTask: jest.fn(),
            updateTask: jest.fn(),
            softDeleteTask: jest.fn(),
            restoreTask: jest.fn(),
            deleteTask: jest.fn(),
            assignTask: jest.fn(),
            findColumnTasks: jest.fn(),
            updateTasksRank: jest.fn(),
            bulkUpdateTasks: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<WorkItemService>(WorkItemService);
    repo = module.get(WorkItemRepository);
    eventEmitter = module.get<EventEmitter2>(EventEmitter2);
    cache = module.get(RedisCacheService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should create task successfully with identifier and emit task.created', async () => {
    repo.createTask.mockResolvedValue({
      id: 't-1',
      title: 'Write literature review',
      columnId: 'col-todo',
      rank: 0,
      identifier: 'AI-1',
      sequenceNumber: 1,
      projectId: 'proj-1',
      project: { id: 'proj-1', workspaceId: 'ws-1' },
    } as any);

    const result = await service.createTask('proj-1', 'user-1', {
      title: 'Write literature review',
      columnId: 'col-todo',
    });

    expect(result.task?.title).toBe('Write literature review');
    expect(result.task?.identifier).toBe('AI-1');
    expect(cache.del).toHaveBeenCalled();
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'task.created',
      expect.objectContaining({
        entityId: 't-1',
        projectId: 'proj-1',
      }),
    );
  });

  it('should get project tasks with query filters', async () => {
    repo.findProjectTasks.mockResolvedValue([
      {
        id: 't-1',
        title: 'Task 1',
        columnId: 'col-todo',
        priority: TaskPriority.high,
        projectId: 'proj-1',
      } as any,
    ]);

    const result = await service.getProjectTasks('proj-1', {
      priority: TaskPriority.high,
      search: 'Task',
    });

    expect(result.tasks).toHaveLength(1);
    expect(repo.findProjectTasks).toHaveBeenCalledWith('proj-1', {
      priority: TaskPriority.high,
      search: 'Task',
      columnId: undefined,
      assigneeId: undefined,
      cycleId: undefined,
      completed: undefined,
      parentTaskId: undefined,
      limit: undefined,
      offset: undefined,
    });
  });

  it('should update task and mark completed when column is done', async () => {
    repo.findTaskById.mockResolvedValue({
      id: 't-1',
      projectId: 'proj-1',
    } as any);
    repo.updateTask.mockResolvedValue({
      id: 't-1',
      title: 'Write literature review',
      columnId: 'done',
      completed: true,
      projectId: 'proj-1',
      project: { id: 'proj-1', workspaceId: 'ws-1' },
    } as any);

    const result = await service.updateTask('t-1', {
      columnId: 'done',
    });

    expect(repo.updateTask).toHaveBeenCalledWith(
      't-1',
      expect.objectContaining({
        columnId: 'done',
        completed: true,
      }),
    );
    expect(result.task?.completed).toBe(true);
    expect(cache.del).toHaveBeenCalled();
  });

  it('should soft delete task and invalidate cache', async () => {
    repo.findTaskById.mockResolvedValue({
      id: 't-1',
      projectId: 'proj-1',
      authorId: 'user-1',
      project: { id: 'proj-1', workspaceId: 'ws-1' },
    } as any);
    repo.softDeleteTask.mockResolvedValue({ id: 't-1' } as any);

    const result = await service.deleteTask('t-1');

    expect(repo.softDeleteTask).toHaveBeenCalledWith('t-1');
    expect(result.message).toContain('soft-deleted');
    expect(cache.del).toHaveBeenCalled();
  });

  it('should restore soft-deleted task', async () => {
    repo.restoreTask.mockResolvedValue({
      id: 't-1',
      projectId: 'proj-1',
    } as any);

    const result = await service.restoreTask('t-1');
    expect(result.message).toContain('restored successfully');
    expect(repo.restoreTask).toHaveBeenCalledWith('t-1');
  });

  it('should duplicate task and emit domain activity event', async () => {
    repo.findTaskById.mockResolvedValue({
      id: 't-1',
      title: 'Original Task',
      columnId: 'col-todo',
      priority: TaskPriority.medium,
      projectId: 'proj-1',
    } as any);
    repo.createTask.mockResolvedValue({
      id: 't-2',
      title: 'Original Task (Copy)',
      columnId: 'col-todo',
      projectId: 'proj-1',
      identifier: 'AI-2',
      sequenceNumber: 2,
    } as any);

    const result = await service.duplicateTask('t-1', 'user-1');
    expect(result.task?.title).toBe('Original Task (Copy)');
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'task.created',
      expect.objectContaining({
        entityId: 't-2',
        projectId: 'proj-1',
      }),
    );
  });
});
