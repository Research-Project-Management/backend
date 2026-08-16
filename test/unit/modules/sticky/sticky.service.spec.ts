import { Test, TestingModule } from '@nestjs/testing';
import { StickyService } from '@/modules/sticky/sticky.service';
import { StickyRepository } from '@/modules/sticky/sticky.repository';



describe('StickyService', () => {
  let service: StickyService;
  let repo: StickyRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StickyService,
        {
          provide: StickyRepository,
          useValue: {
            findWorkspaceStickies: jest.fn(),
            findProjectStickies: jest.fn(),
            countWorkspaceStickies: jest.fn().mockResolvedValue(0),
            countProjectStickies: jest.fn().mockResolvedValue(0),
            createSticky: jest.fn(),
            updateSticky: jest.fn(),
            deleteSticky: jest.fn(),
            reorderStickies: jest.fn(),
            findProjectWorkspaceId: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<StickyService>(StickyService);
    repo = module.get<StickyRepository>(StickyRepository);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should create workspace sticky successfully', async () => {
    (repo.createSticky as jest.Mock).mockResolvedValue({
      id: 's-1',
      content: 'Brainstorm ideas',
      color: 'yellow-1',
      positionX: 100,
      positionY: 200,
    });

    const result = await service.createWorkspaceSticky('ws-1', 'user-1', {
      content: 'Brainstorm ideas',
      position: { x: 100, y: 200 },
    });

    expect(result.sticky.content).toBe('Brainstorm ideas');
    expect(result.sticky.id).toBe('s-1');
  });
});
