import { Test, TestingModule } from '@nestjs/testing';
import { FileService } from '@/modules/storage/file/file.service';
import { FileRepository } from '@/modules/storage/file/file.repository';
import { R2Service } from '@/modules/storage/r2/r2.service';

describe('FileService', () => {
  let service: FileService;
  let repo: FileRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FileService,
        {
          provide: FileRepository,
          useValue: {
            createFile: jest.fn(),
            findFileById: jest.fn(),
            updateFile: jest.fn(),
            deleteFile: jest.fn(),
            upsertFileShare: jest.fn(),
            findFiles: jest.fn(),
            findFileShares: jest.fn(),
            findWorkspaceMemberRole: jest.fn().mockResolvedValue('member'),
            findProjectMemberRole: jest.fn().mockResolvedValue('contributor'),
            findPageScope: jest.fn().mockResolvedValue({ workspaceId: 'ws-1', projectId: null }),
            findProjectScope: jest.fn().mockResolvedValue({ workspaceId: 'ws-1' }),
          },
        },
        {
          provide: R2Service,
          useValue: {
            getPresignedUploadUrl: jest.fn().mockResolvedValue({
              signedUrl: 'https://r2.mock.url',
              path: 'workspace/ws-1/test.pdf',
              url: '/api/files/r2/workspace/ws-1/test.pdf',
            }),
            deleteObject: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    service = module.get<FileService>(FileService);
    repo = module.get<FileRepository>(FileRepository);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should generate presigned upload url', async () => {
    const result = await service.presign({
      filename: 'workspace/ws-1/test.pdf',
    });
    expect(result.signedUrl).toBe('https://r2.mock.url');
    expect(result.url).toBe('/api/files/r2/workspace/ws-1/test.pdf');
  });

  it('should create file record on upload', async () => {
    (repo.createFile as jest.Mock).mockResolvedValue({
      id: 'f-1',
      filename: 'paper.pdf',
      size: 1024,
      authorId: 'user-1',
    });

    const result = await service.upload(
      'user-1',
      { workspaceId: 'ws-1' },
      {
        filename: 'paper.pdf',
        size: 1024,
        url: 'https://r2.url/paper.pdf',
      },
    );

    expect(result.file.filename).toBe('paper.pdf');
    expect(result.file.id).toBe('f-1');
  });
});
