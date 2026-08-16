import { Test, TestingModule } from '@nestjs/testing';
import { ChatService } from '@/modules/ai/chat/chat.service';
import { ConfigService } from '@nestjs/config';

describe('ChatService', () => {
  let service: ChatService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue('http://localhost:8000'),
          },
        },
      ],
    }).compile();

    service = module.get<ChatService>(ChatService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should return empty assistant response for empty query', async () => {
    const result = await service.chatSync('u-1', { query: '' });
    expect(result.role).toBe('assistant');
    expect(result.content).toBe('');
  });
});
