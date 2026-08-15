import { Test, TestingModule } from '@nestjs/testing';
import { CommentService } from '@/modules/collaboration/comment/comment.service';
import { CommentRepository } from '@/modules/collaboration/comment/comment.repository';

describe('CommentService', () => {
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
            findPageComments: jest.fn(),
            findPageCommentById: jest.fn(),
            createPageComment: jest.fn(),
            updatePageComment: jest.fn(),
            deletePageComment: jest.fn(),
            findTaskComments: jest.fn(),
            countTaskComments: jest.fn(),
            findTaskCommentById: jest.fn(),
            createTaskComment: jest.fn(),
            updateTaskComment: jest.fn(),
            deleteTaskComment: jest.fn(),
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

  it('should create page comment successfully', async () => {
    (repo.createPageComment as jest.Mock).mockResolvedValue({
      id: 'c-1',
      pageId: 'pg-1',
      authorId: 'user-1',
      content: 'Needs reference here',
      line: 42,
    });

    const result = await service.createPageComment('pg-1', 'user-1', {
      content: 'Needs reference here',
      line: 42,
    });

    expect(result.comment.content).toBe('Needs reference here');
    expect(result.comment.id).toBe('c-1');
  });
});
