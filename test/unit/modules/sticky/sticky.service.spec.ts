import { Test, TestingModule } from '@nestjs/testing';
import { StickyService } from '@/modules/sticky/sticky.service';
import { StickyRepository } from '@/modules/sticky/sticky.repository';
import { ForbiddenException } from '@nestjs/common';

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
            findStickyById: jest.fn(),
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

  it('should get workspace stickies scoped to user', async () => {
    (repo.findWorkspaceStickies as jest.Mock).mockResolvedValue([
      {
        id: 's-1',
        content: 'Idea 1',
        positionX: 10,
        positionY: 20,
        userId: 'user-1',
      },
    ]);

    const result = await service.getWorkspaceStickies('ws-1', 'user-1');

    expect(repo.findWorkspaceStickies).toHaveBeenCalledWith('ws-1', 'user-1');
    expect(result.stickies.length).toBe(1);
    expect(result.stickies[0]?.position).toEqual({ x: 10, y: 20 });
  });

  it('should create workspace sticky successfully', async () => {
    (repo.createSticky as jest.Mock).mockResolvedValue({
      id: 's-1',
      content: 'Brainstorm ideas',
      color: 'yellow-1',
      positionX: 100,
      positionY: 200,
      userId: 'user-1',
    });

    const result = await service.createWorkspaceSticky('ws-1', 'user-1', {
      content: 'Brainstorm ideas',
      position: { x: 100, y: 200 },
    });

    expect(result.sticky?.content).toBe('Brainstorm ideas');
    expect(result.sticky?.id).toBe('s-1');
  });

  it('should throw ForbiddenException when updating sticky owned by another user', async () => {
    (repo.findStickyById as jest.Mock).mockResolvedValue({
      id: 's-1',
      userId: 'user-2',
    });

    await expect(
      service.updateSticky('s-1', 'user-1', { content: 'Hacked' }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('should update sticky when user is owner', async () => {
    (repo.findStickyById as jest.Mock).mockResolvedValue({
      id: 's-1',
      userId: 'user-1',
    });
    (repo.updateSticky as jest.Mock).mockResolvedValue({
      id: 's-1',
      content: 'Updated content',
      positionX: 50,
      positionY: 50,
      userId: 'user-1',
    });

    const result = await service.updateSticky('s-1', 'user-1', {
      content: 'Updated content',
    });

    expect(result.sticky?.content).toBe('Updated content');
  });

  it('should throw ForbiddenException when deleting sticky owned by another user', async () => {
    (repo.findStickyById as jest.Mock).mockResolvedValue({
      id: 's-1',
      userId: 'user-2',
    });

    await expect(service.deleteSticky('s-1', 'user-1')).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('should delete sticky successfully when user is owner', async () => {
    (repo.findStickyById as jest.Mock).mockResolvedValue({
      id: 's-1',
      userId: 'user-1',
    });
    (repo.deleteSticky as jest.Mock).mockResolvedValue(undefined);

    const result = await service.deleteSticky('s-1', 'user-1');

    expect(repo.deleteSticky).toHaveBeenCalledWith('s-1');
    expect(result.success).toBe(true);
  });
});
