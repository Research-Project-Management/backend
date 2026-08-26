import { Test, TestingModule } from '@nestjs/testing';
import { LabelService } from '@/modules/shared/label/label.service';
import { LabelRepository } from '@/modules/shared/label/label.repository';
import { RedisCacheService } from '@/core/cache/redis-cache.service';

describe('LabelService', () => {
  let service: LabelService;
  let repo: jest.Mocked<LabelRepository>;
  let cache: jest.Mocked<RedisCacheService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LabelService,
        {
          provide: RedisCacheService,
          useValue: {
            get: jest.fn(),
            set: jest.fn(),
            del: jest.fn(),
          },
        },
        {
          provide: LabelRepository,
          useValue: {
            findWorkspaceLabels: jest.fn(),
            findLabelById: jest.fn(),
            createLabel: jest.fn(),
            updateLabel: jest.fn(),
            deleteLabel: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<LabelService>(LabelService);
    repo = module.get(LabelRepository);
    cache = module.get(RedisCacheService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should create label successfully and invalidate cache', async () => {
    repo.createLabel.mockResolvedValue({
      id: 'l-1',
      name: 'Bug',
      color: '#ef4444',
      workspaceId: 'ws-1',
      createdById: 'user-1',
      type: 'sticky',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);

    const result = await service.createLabel('ws-1', 'user-1', {
      name: 'Bug',
      color: '#ef4444',
    });

    expect(result.label.name).toBe('Bug');
    expect(result.label.id).toBe('l-1');
    expect(cache.del).toHaveBeenCalled();
  });

  it('should return cached labels when available', async () => {
    cache.get.mockResolvedValue({
      labels: [{ id: 'l-1', name: 'Frontend' }],
    });

    const result = await service.getLabels('ws-1');
    expect(result.labels.length).toBe(1);
    expect(repo.findWorkspaceLabels).not.toHaveBeenCalled();
  });
});
