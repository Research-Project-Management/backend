import { Test, TestingModule } from '@nestjs/testing';
import { CommentService } from '@/modules/shared/comment/comment.service';
import { CommentRepository } from '@/modules/shared/comment/comment.repository';

describe('Shared CommentService', () => {
  let service: CommentService;
  let repo: CommentRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommentService,
        {
          provide: CommentRepository,
          useValue: {
            findAuthorById: jest.fn(),
            findTaskComments: jest.fn(),
            findTaskCommentById: jest.fn(),
            createTaskComment: jest.fn(),
            updateTaskComment: jest.fn(),
            deleteTaskComment: jest.fn(),
            findPageComments: jest.fn(),
            findPageCommentById: jest.fn(),
            createPageComment: jest.fn(),
            updatePageComment: jest.fn(),
            deletePageComment: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<CommentService>(CommentService);
    repo = module.get<CommentRepository>(CommentRepository);
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

  it('should get page comments', async () => {
    (repo.findPageComments as jest.Mock).mockResolvedValue([
      { id: 'pc-1', content: 'Page comment', pageId: 'p-1' },
    ]);

    const result = await service.getPageComments('p-1');
    expect(result.comments.length).toBe(1);
  });
});
