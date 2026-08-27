import { Test, TestingModule } from '@nestjs/testing';
import { PageCommentService } from '@/modules/document/comment/comment.service';
import { PageCommentRepository } from '@/modules/document/comment/comment.repository';

describe('PageCommentService', () => {
  let service: PageCommentService;
  let repo: PageCommentRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PageCommentService,
        {
          provide: PageCommentRepository,
          useValue: {
            findAuthorById: jest.fn(),
            findPageComments: jest.fn(),
            findPageCommentById: jest.fn(),
            createPageComment: jest.fn(),
            updatePageComment: jest.fn(),
            deletePageComment: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<PageCommentService>(PageCommentService);
    repo = module.get<PageCommentRepository>(PageCommentRepository);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should get page comments', async () => {
    (repo.findPageComments as jest.Mock).mockResolvedValue([
      { id: 'pc-1', content: 'Page comment', pageId: 'p-1' },
    ]);

    const result = await service.getPageComments('p-1');
    expect(result.comments.length).toBe(1);
  });
});
