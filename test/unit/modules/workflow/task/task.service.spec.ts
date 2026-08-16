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
            getAuditLog: jest.fn(),
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
});
