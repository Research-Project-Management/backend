import { Test, TestingModule } from '@nestjs/testing';
import { LabelService } from '@/modules/storage/label/label.service';
import { LabelRepository } from '@/modules/storage/label/label.repository';

describe('LabelService', () => {
  let service: LabelService;
  let repo: LabelRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LabelService,
        {
          provide: LabelRepository,
          useValue: {
            findWorkspaceLabels: jest.fn(),
            createLabel: jest.fn(),
            updateLabel: jest.fn(),
            deleteLabel: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<LabelService>(LabelService);
    repo = module.get<LabelRepository>(LabelRepository);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should create label successfully', async () => {
    (repo.createLabel as jest.Mock).mockResolvedValue({
      id: 'l-1',
      name: 'Bug',
      color: '#ef4444',
      workspaceId: 'ws-1',
    });

    const result = await service.createLabel('ws-1', 'user-1', {
      name: 'Bug',
      color: '#ef4444',
    });

    expect(result.label.name).toBe('Bug');
    expect(result.label.id).toBe('l-1');
  });
});
