import { Test, TestingModule } from '@nestjs/testing';
import { TaskCommentService } from '@/modules/work-item/comment/comment.service';
import { TaskCommentRepository } from '@/modules/work-item/comment/comment.repository';

describe('TaskCommentService', () => {
  let service: TaskCommentService;
  let repo: TaskCommentRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TaskCommentService,
        {
          provide: TaskCommentRepository,
          useValue: {
            findAuthorById: jest.fn(),
            findTaskComments: jest.fn(),
            findTaskCommentById: jest.fn(),
            createTaskComment: jest.fn(),
            updateTaskComment: jest.fn(),
            deleteTaskComment: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<TaskCommentService>(TaskCommentService);
    repo = module.get<TaskCommentRepository>(TaskCommentRepository);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should get task comments', async () => {
    (repo.findTaskComments as jest.Mock).mockResolvedValue([
      { id: 'tc-1', content: 'Task comment', taskId: 't-1' },
    ]);

    const result = await service.getTaskComments('t-1');
    expect(result.comments.length).toBe(1);
  });
});
