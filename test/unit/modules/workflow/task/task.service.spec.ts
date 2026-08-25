import { Test, TestingModule } from '@nestjs/testing';
import { TaskService } from '@/modules/workflow/task/task.service';
import { TaskRepository } from '@/modules/workflow/task/task.repository';
import { EventEmitter2 } from '@nestjs/event-emitter';

describe('TaskService', () => {
  let service: TaskService;
  let repo: TaskRepository;
  let eventEmitter: EventEmitter2;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TaskService,
        {
          provide: EventEmitter2,
          useValue: {
            emit: jest.fn(),
          },
        },
        {
          provide: TaskRepository,
          useValue: {
            findWorkspaceTasks: jest.fn(),
            findProjectTasks: jest.fn(),
            findTaskById: jest.fn(),
            countColumnTasks: jest.fn().mockResolvedValue(0),
            nextProjectTaskIdentifier: jest.fn().mockResolvedValue('TASK-1'),
            createTask: jest.fn(),
            updateTask: jest.fn(),
            deleteTask: jest.fn(),
            assignTask: jest.fn(),
            findColumnTasks: jest.fn(),
            updateTasksRank: jest.fn(),
            bulkUpdateTasks: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<TaskService>(TaskService);
    repo = module.get<TaskRepository>(TaskRepository);
    eventEmitter = module.get<EventEmitter2>(EventEmitter2);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should create task successfully and emit task.created', async () => {
    (repo.createTask as jest.Mock).mockResolvedValue({
      id: 't-1',
      title: 'Write literature review',
      columnId: 'col-todo',
      rank: 0,
      projectId: 'proj-1',
      project: { id: 'proj-1', workspaceId: 'ws-1' },
    });

    const result = await service.createTask('proj-1', 'user-1', {
      title: 'Write literature review',
      columnId: 'col-todo',
    });

    expect(result.task?.title).toBe('Write literature review');
    expect(result.task?.id).toBe('t-1');
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'task.created',
      expect.objectContaining({
        entityId: 't-1',
        projectId: 'proj-1',
      }),
    );
  });

  it('should update task and mark completed when column is done', async () => {
    (repo.updateTask as jest.Mock).mockResolvedValue({
      id: 't-1',
      title: 'Write literature review',
      columnId: 'done',
      completed: true,
      projectId: 'proj-1',
      project: { id: 'proj-1', workspaceId: 'ws-1' },
    });

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
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'task.updated',
      expect.objectContaining({
        entityId: 't-1',
        verb: 'moved',
      }),
    );
  });

  it('should reorder tasks and emit task.reordered event', async () => {
    (repo.findColumnTasks as jest.Mock).mockImplementation((_pid, colId) => {
      if (colId === 'col-todo') {
        return Promise.resolve([
          { id: 't-1', rank: 0 },
          { id: 't-2', rank: 1 },
        ]);
      }
      return Promise.resolve([]);
    });
    (repo.updateTasksRank as jest.Mock).mockResolvedValue(undefined);

    const result = await service.reorderTasks('proj-1', {
      sourceColumnId: 'col-todo',
      destinationColumnId: 'col-inprogress',
      sourceIndex: 0,
      destinationIndex: 0,
    });

    expect(result.success).toBe(true);
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'task.reordered',
      expect.objectContaining({
        projectId: 'proj-1',
        verb: 'reordered',
        field: 'columnId',
        newValue: 'col-inprogress',
      }),
    );
  });

  it('should bulk update tasks and emit task.bulk_updated event', async () => {
    (repo.bulkUpdateTasks as jest.Mock).mockResolvedValue({ count: 2 });

    const result = await service.bulkUpdateTasks('proj-1', {
      taskIds: ['t-1', 't-2'],
      data: { columnId: 'done' },
    });

    expect(result.success).toBe(true);
    expect(result.count).toBe(2);
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'task.bulk_updated',
      expect.objectContaining({
        projectId: 'proj-1',
        verb: 'bulk_updated',
      }),
    );
  });

  it('should throw NotFoundException when deleting non-existent task', async () => {
    (repo.findTaskById as jest.Mock).mockResolvedValue(null);

    await expect(service.deleteTask('non-existing-task')).rejects.toThrow();
  });

  it('should delete existing task and return success', async () => {
    (repo.findTaskById as jest.Mock).mockResolvedValue({
      id: 't-1',
      projectId: 'proj-1',
      authorId: 'user-1',
      project: { id: 'proj-1', workspaceId: 'ws-1' },
    });
    (repo.deleteTask as jest.Mock).mockResolvedValue(undefined);

    const result = await service.deleteTask('t-1');

    expect(repo.deleteTask).toHaveBeenCalledWith('t-1');
    expect(result.success).toBe(true);
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'task.deleted',
      expect.objectContaining({
        entityId: 't-1',
        projectId: 'proj-1',
      }),
    );
  });

  it('should assign task and emit task.updated event', async () => {
    (repo.assignTask as jest.Mock).mockResolvedValue({
      id: 't-1',
      title: 'Write literature review',
      columnId: 'col-todo',
      rank: 0,
      projectId: 'proj-1',
      project: { id: 'proj-1', workspaceId: 'ws-1' },
      assigneeId: 'user-2',
      assignee: { id: 'user-2', name: 'Bob' },
    });

    const result = await service.assignTask('t-1', 'user-2');

    expect(result.task?.id).toBe('t-1');
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'task.updated',
      expect.objectContaining({
        entityId: 't-1',
        verb: 'assigned',
        field: 'assigneeId',
        newValue: 'user-2',
      }),
    );
  });
});
