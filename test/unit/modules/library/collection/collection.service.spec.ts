import { Test, TestingModule } from '@nestjs/testing';
import { CollectionService } from '@/modules/library/collection/collection.service';
import { CollectionRepository } from '@/modules/library/collection/collection.repository';

describe('CollectionService', () => {
  let service: CollectionService;
  let repo: CollectionRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CollectionService,
        {
          provide: CollectionRepository,
          useValue: {
            findWorkspaceCollections: jest.fn(),
            findCollectionById: jest.fn(),
            createCollection: jest.fn(),
            updateCollection: jest.fn(),
            deleteCollection: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<CollectionService>(CollectionService);
    repo = module.get<CollectionRepository>(CollectionRepository);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should create collection successfully', async () => {
    (repo.createCollection as jest.Mock).mockResolvedValue({
      id: 'c-1',
      name: 'AI Papers',
      workspaceId: 'ws-1',
    });

    const result = await service.createCollection('ws-1', 'user-1', {
      name: 'AI Papers',
    });

    expect(result.collection.name).toBe('AI Papers');
    expect(result.collection.id).toBe('c-1');
  });
});
