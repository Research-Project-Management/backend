import { Test, TestingModule } from '@nestjs/testing';
import { TaskService } from '@/modules/workflow/task/task.service';
import { TaskRepository } from '@/modules/workflow/task/task.repository';

describe('TaskService', () => {
  let service: TaskService;
  let repo: TaskRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TaskService,
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
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should create task successfully', async () => {
    (repo.createTask as jest.Mock).mockResolvedValue({
      id: 't-1',
      title: 'Write literature review',
      columnId: 'col-todo',
      rank: 0,
    });

    const result = await service.createTask('proj-1', 'user-1', {
      title: 'Write literature review',
      columnId: 'col-todo',
    });

    expect(result.task?.title).toBe('Write literature review');
    expect(result.task?.id).toBe('t-1');
  });

  it('should update task and mark completed when column is done', async () => {
    (repo.updateTask as jest.Mock).mockResolvedValue({
      id: 't-1',
      title: 'Write literature review',
      columnId: 'done',
      completed: true,
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
  });
});
