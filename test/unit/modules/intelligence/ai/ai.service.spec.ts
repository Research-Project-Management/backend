import { Test, TestingModule } from '@nestjs/testing';
import { AiService } from '@/modules/intelligence/ai/ai.service';
import { ConfigService } from '@nestjs/config';

describe('AiService', () => {
  let service: AiService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue('http://localhost:8000'),
          },
        },
      ],
    }).compile();

    service = module.get<AiService>(AiService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should return fallback health response when offline', async () => {
    const health = await service.health();
    expect(health.status).toBeDefined();
  });
});
