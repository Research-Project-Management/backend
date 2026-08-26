import { Test, TestingModule } from '@nestjs/testing';
import { FileService } from '@/modules/storage/file/file.service';
import { FileRepository } from '@/modules/storage/file/file.repository';
import { R2Service } from '@/modules/storage/r2/r2.service';
import { PrismaService } from '@/core/database/prisma.service';
import { RedisCacheService } from '@/core/cache/redis-cache.service';
import { BadRequestException } from '@nestjs/common';

describe('FileService', () => {
  let service: FileService;
  let repo: jest.Mocked<FileRepository>;
  let cache: jest.Mocked<RedisCacheService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FileService,
        {
          provide: RedisCacheService,
          useValue: {
            get: jest.fn(),
            set: jest.fn(),
            del: jest.fn(),
            delPattern: jest.fn(),
          },
        },
        {
          provide: FileRepository,
          useValue: {
            createFile: jest.fn(),
            findFileById: jest.fn(),
            updateFile: jest.fn(),
            deleteFile: jest.fn(),
            trashFile: jest.fn(),
            restoreFile: jest.fn(),
            upsertFileShare: jest.fn(),
            findFiles: jest.fn(),
            findFileShares: jest.fn(),
            findWorkspaceMemberRole: jest.fn().mockResolvedValue('member'),
            findProjectMemberRole: jest.fn().mockResolvedValue('contributor'),
            findPageScope: jest
              .fn()
              .mockResolvedValue({ workspaceId: 'ws-1', projectId: null }),
            findProjectScope: jest
              .fn()
              .mockResolvedValue({ workspaceId: 'ws-1' }),
            calculateWorkspaceStorageUsage: jest
              .fn()
              .mockResolvedValue(1048576),
          },
        },
        {
          provide: R2Service,
          useValue: {
            getPresignedUploadUrl: jest.fn().mockResolvedValue({
              signedUrl: 'https://r2.mock.url/upload',
              path: 'workspace/ws-1/test.pdf',
              url: '/api/files/r2/workspace/ws-1/test.pdf',
            }),
            deleteObject: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: PrismaService,
          useValue: {
            workspace: {
              findFirst: jest.fn().mockResolvedValue({ id: 'ws-1' }),
            },
            project: {
              findUnique: jest.fn().mockResolvedValue({ workspaceId: 'ws-1' }),
            },
            page: {
              findUnique: jest.fn().mockResolvedValue({ workspaceId: 'ws-1' }),
            },
          },
        },
      ],
    }).compile();

    service = module.get<FileService>(FileService);
    repo = module.get(FileRepository);
    cache = module.get(RedisCacheService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should generate presigned upload url', async () => {
    const result = await service.presign({
      filename: 'test.pdf',
    });
    expect(result.signedUrl).toBe('https://r2.mock.url/upload');
    expect(result.path).toBe('workspace/ws-1/test.pdf');
  });

  it('should create file record on upload and invalidate cache', async () => {
    repo.createFile.mockResolvedValue({
      id: 'f-1',
      filename: 'paper.pdf',
      size: 1024,
      authorId: 'user-1',
      workspaceId: 'ws-1',
    } as any);

    const result = await service.upload(
      'user-1',
      { workspaceId: 'ws-1' },
      {
        filename: 'paper.pdf',
        size: 1024,
        url: 'https://r2.url/paper.pdf',
      },
    );

    expect(result.file?.filename).toBe('paper.pdf');
    expect(result.file?.id).toBe('f-1');
    expect(cache.delPattern).toHaveBeenCalled();
  });

  it('should prevent circular folder move', async () => {
    repo.findFileById.mockImplementation((id: string) => {
      if (id === 'folder-1') {
        return Promise.resolve({
          id: 'folder-1',
          filename: 'Root Folder',
          isFolder: true,
          parentId: null,
          authorId: 'user-1',
        } as any);
      }
      if (id === 'folder-2') {
        return Promise.resolve({
          id: 'folder-2',
          filename: 'Sub Folder',
          isFolder: true,
          parentId: 'folder-1',
          authorId: 'user-1',
        } as any);
      }
      return Promise.resolve(null);
    });

    // Attempting to move folder-1 into folder-2 (which is inside folder-1)
    await expect(
      service.moveFile('folder-1', 'user-1', 'folder-2'),
    ).rejects.toThrow(BadRequestException);
  });

  it('should calculate and cache storage usage quota', async () => {
    const usage = await service.getStorageUsage('ws-1');
    expect(usage.totalBytes).toBe(1048576);
    expect(repo.calculateWorkspaceStorageUsage).toHaveBeenCalledWith('ws-1');
    expect(cache.set).toHaveBeenCalled();
  });
});
