import { Test, TestingModule } from '@nestjs/testing';
import { ChatHistoryService } from '@/modules/intelligence/chat-history/chat-history.service';
import { ChatHistoryRepository } from '@/modules/intelligence/chat-history/chat-history.repository';

describe('ChatHistoryService', () => {
  let service: ChatHistoryService;
  let repo: ChatHistoryRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatHistoryService,
        {
          provide: ChatHistoryRepository,
          useValue: {
            findUserChats: jest.fn(),
            findChatById: jest.fn(),
            findPageChat: jest.fn(),
            createChat: jest.fn(),
            updateChat: jest.fn(),
            deleteChat: jest.fn(),
            deleteChats: jest.fn(),
            createMessage: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<ChatHistoryService>(ChatHistoryService);
    repo = module.get<ChatHistoryRepository>(ChatHistoryRepository);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should create chat session successfully', async () => {
    (repo.createChat as jest.Mock).mockResolvedValue({
      id: 'chat-1',
      title: 'Literature Review Chat',
      userId: 'user-1',
    });

    const result = await service.createChat('user-1', {
      title: 'Literature Review Chat',
    });

    expect(result.title).toBe('Literature Review Chat');
    expect(result.id).toBe('chat-1');
  });
});
