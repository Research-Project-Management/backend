import { Test, TestingModule } from '@nestjs/testing';
import { ThreadService } from '@/modules/ai/thread/thread.service';
import { ThreadRepository } from '@/modules/ai/thread/thread.repository';

describe('ThreadService', () => {
  let service: ThreadService;
  let repo: ThreadRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ThreadService,
        {
          provide: ThreadRepository,
          useValue: {
            findUserChats: jest.fn(),
            findChatById: jest.fn(),
            findPageChat: jest.fn(),
            createChat: jest.fn(),
            updateChat: jest.fn(),
            deleteChat: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<ThreadService>(ThreadService);
    repo = module.get<ThreadRepository>(ThreadRepository);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should get user chat threads', async () => {
    (repo.findUserChats as jest.Mock).mockResolvedValue([
      { id: 'ch-1', title: 'Discussion on RAG', workspaceId: 'ws-1' },
    ]);

    const result = await service.getChats('ws-1', 'u-1');
    expect(result.length).toBe(1);
    expect(result[0].title).toBe('Discussion on RAG');
  });
});
