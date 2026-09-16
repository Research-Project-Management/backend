import { Test, TestingModule } from '@nestjs/testing';
import { AssetService } from '@/modules/document/asset/asset.service';
import { PrismaService } from '@/core/database/prisma.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { STORAGE_PORT } from '@/modules/storage/storage.port';

describe('Document AssetService (Figures, Images & LaTeX Assets)', () => {
  let service: AssetService;
  let prisma: any;

  const mockProjectId = '11111111-1111-1111-1111-111111111111';
  const mockUserId = '22222222-2222-2222-2222-222222222222';
  const mockAssetId = '33333333-3333-3333-3333-333333333333';

  beforeEach(async () => {
    prisma = {
      page: {
        create: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      file: {
        create: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [AssetService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get<AssetService>(AssetService);
  });

  describe('uploadAsset', () => {
    it('should reject invalid file extensions', async () => {
      await expect(
        service.uploadAsset(mockProjectId, mockUserId, {
          filename: 'dangerous_script.exe',
          contentBase64: 'SGVsbG8=',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject empty filename', async () => {
      await expect(
        service.uploadAsset(mockProjectId, mockUserId, {
          filename: '   ',
          contentBase64: 'SGVsbG8=',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject filename containing path traversal or directory separators', async () => {
      await expect(
        service.uploadAsset(mockProjectId, mockUserId, {
          filename: '../../etc/passwd.png',
          contentBase64: 'SGVsbG8=',
        }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.uploadAsset(mockProjectId, mockUserId, {
          filename: 'nested/figure.png',
          contentBase64: 'SGVsbG8=',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject path containing directory traversal or drive letter', async () => {
      await expect(
        service.uploadAsset(mockProjectId, mockUserId, {
          filename: 'figure.png',
          path: 'figures/../../secret.png',
          contentBase64: 'SGVsbG8=',
        }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.uploadAsset(mockProjectId, mockUserId, {
          filename: 'figure.png',
          path: 'C:/Windows/System32/calc.png',
          contentBase64: 'SGVsbG8=',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should upload valid image asset and return metadata', async () => {
      prisma.page.create.mockResolvedValueOnce({
        id: mockAssetId,
        title: 'architecture.png',
        projectId: mockProjectId,
        parentPageId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const res = await service.uploadAsset(mockProjectId, mockUserId, {
        filename: 'architecture.png',
        contentBase64:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        path: 'figures/architecture.png',
      });

      expect(prisma.page.create).toHaveBeenCalled();
      expect(res.id).toBe(mockAssetId);
      expect(res.filename).toBe('architecture.png');
      expect(res.path).toBe('figures/architecture.png');
      expect(res.mimeType).toBe('image/png');
    });
  });

  describe('getProjectAssets', () => {
    it('should return list of project assets', async () => {
      prisma.page.findMany.mockResolvedValueOnce([
        {
          id: mockAssetId,
          title: 'plot.pdf',
          projectId: mockProjectId,
          parentPageId: null,
          content: {
            isAsset: true,
            filename: 'plot.pdf',
            path: 'figures/plot.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 1024,
          },
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const assets = await service.getProjectAssets(mockProjectId);

      expect(assets).toHaveLength(1);
      expect(assets[0].filename).toBe('plot.pdf');
      expect(assets[0].path).toBe('figures/plot.pdf');
    });
  });

  describe('getProjectAssetMap', () => {
    it('should return filepath to base64 map for compiler integration', async () => {
      prisma.page.findMany.mockResolvedValueOnce([
        {
          id: mockAssetId,
          title: 'architecture.png',
          content: {
            isAsset: true,
            path: 'figures/architecture.png',
            base64: 'IMAGE_BASE64_DATA',
          },
        },
      ]);

      const map = await service.getProjectAssetMap(mockProjectId);

      expect(map['figures/architecture.png']).toBe('IMAGE_BASE64_DATA');
    });
  });

  describe('deleteAsset', () => {
    it('should throw NotFoundException if asset does not exist', async () => {
      prisma.page.findFirst.mockResolvedValueOnce(null);

      await expect(service.deleteAsset(mockAssetId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should soft-delete asset', async () => {
      prisma.page.findFirst.mockResolvedValueOnce({ id: mockAssetId });
      prisma.page.update.mockResolvedValueOnce({ id: mockAssetId });

      const res = await service.deleteAsset(mockAssetId);

      expect(res.ok).toBe(true);
      expect(prisma.page.update).toHaveBeenCalledWith({
        where: { id: mockAssetId },
        data: { deletedAt: expect.any(Date) },
      });
    });
  });

  describe('AssetService with STORAGE_PORT connected', () => {
    let storageService: AssetService;
    let mockStoragePort: any;

    beforeEach(async () => {
      mockStoragePort = {
        uploadFile: jest.fn().mockResolvedValue({
          fileId: 'file-123',
          url: '/api/files/file-123/content',
          path: 'attachments/file-123.png',
          filename: 'architecture.png',
          size: 100,
          mimeType: 'image/png',
        }),
        readOwnedFile: jest.fn().mockResolvedValue({
          fileId: 'file-123',
          filename: 'architecture.png',
          mimeType: 'image/png',
          size: 100,
          storageKey: 'attachments/file-123.png',
          contentUrl: '/api/files/file-123/content',
          buffer: Buffer.from('TEST_BINARY_PAYLOAD'),
        }),
        deleteFile: jest.fn().mockResolvedValue(undefined),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          AssetService,
          { provide: PrismaService, useValue: prisma },
          { provide: STORAGE_PORT, useValue: mockStoragePort },
        ],
      }).compile();

      storageService = module.get<AssetService>(AssetService);
    });

    it('should upload binary to storagePort and attach fileId/storageUrl', async () => {
      prisma.page.create.mockResolvedValueOnce({
        id: mockAssetId,
        title: 'architecture.png',
        projectId: mockProjectId,
        parentPageId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const res = await storageService.uploadAsset(mockProjectId, mockUserId, {
        filename: 'architecture.png',
        contentBase64:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        path: 'figures/architecture.png',
      });

      expect(mockStoragePort.uploadFile).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: mockUserId,
          filename: 'architecture.png',
          projectId: mockProjectId,
          source: 'document',
        }),
      );
      expect(prisma.page.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            content: expect.not.objectContaining({
              base64: expect.anything(),
            }),
          }),
        }),
      );
      expect(res.fileId).toBe('file-123');
      expect(res.storageUrl).toBe('/api/files/file-123/content');
    });

    it('should retrieve binary from storagePort when base64 is not saved in JSON', async () => {
      prisma.page.findFirst.mockResolvedValueOnce({
        id: mockAssetId,
        title: 'architecture.png',
        projectId: mockProjectId,
        parentPageId: null,
        content: {
          isAsset: true,
          fileId: 'file-123',
          mimeType: 'image/png',
          base64: '',
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const res = await storageService.getAsset(mockAssetId);

      expect(mockStoragePort.readOwnedFile).toHaveBeenCalledWith({
        fileId: 'file-123',
      });
      expect(res.contentBase64).toBe(
        Buffer.from('TEST_BINARY_PAYLOAD').toString('base64'),
      );
    });

    it('should delete storage file when deleting asset', async () => {
      prisma.page.findFirst.mockResolvedValueOnce({
        id: mockAssetId,
        content: { fileId: 'file-123' },
      });
      prisma.page.update.mockResolvedValueOnce({ id: mockAssetId });

      await storageService.deleteAsset(mockAssetId);

      expect(mockStoragePort.deleteFile).toHaveBeenCalledWith('file-123');
      expect(prisma.page.update).toHaveBeenCalled();
    });

    it('should discover and load storage files from prisma.file in getProjectAssetMap', async () => {
      prisma.page.findMany.mockResolvedValueOnce([]);
      prisma.file.findMany.mockResolvedValueOnce([
        {
          id: 'storage-file-456',
          filename: 'diagram.png',
          size: 2048n,
          mimeType: 'image/png',
          metaData: { path: 'figures/diagram.png' },
        },
      ]);
      mockStoragePort.readOwnedFile.mockResolvedValueOnce({
        fileId: 'storage-file-456',
        filename: 'diagram.png',
        mimeType: 'image/png',
        size: 2048,
        storageKey: 'diagram.png',
        contentUrl: '/api/files/storage-file-456/content',
        buffer: Buffer.from('DIAGRAM_PAYLOAD'),
      });

      const map = await storageService.getProjectAssetMap(mockProjectId);

      expect(mockStoragePort.readOwnedFile).toHaveBeenCalledWith({
        fileId: 'storage-file-456',
      });
      expect(map['diagram.png']).toBe(
        Buffer.from('DIAGRAM_PAYLOAD').toString('base64'),
      );
      expect(map['figures/diagram.png']).toBe(
        Buffer.from('DIAGRAM_PAYLOAD').toString('base64'),
      );
    });

    it('should find asset in prisma.file if not in prisma.page in getAsset', async () => {
      prisma.page.findFirst.mockResolvedValueOnce(null);
      prisma.file.findFirst.mockResolvedValueOnce({
        id: 'storage-node-789',
        filename: 'chart.pdf',
        size: 4096n,
        mimeType: 'application/pdf',
        metaData: {},
        url: '/api/files/storage-node-789/content',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockStoragePort.readOwnedFile.mockResolvedValueOnce({
        fileId: 'storage-node-789',
        filename: 'chart.pdf',
        mimeType: 'application/pdf',
        size: 4096,
        storageKey: 'chart.pdf',
        contentUrl: '/api/files/storage-node-789/content',
        buffer: Buffer.from('CHART_BUFFER'),
      });

      const res = await storageService.getAsset('storage-node-789');

      expect(res.id).toBe('storage-node-789');
      expect(res.filename).toBe('chart.pdf');
      expect(res.contentBase64).toBe(
        Buffer.from('CHART_BUFFER').toString('base64'),
      );
    });

    it('should soft-delete in prisma.file if asset is in storage', async () => {
      prisma.page.findFirst.mockResolvedValueOnce(null);
      prisma.file.findFirst.mockResolvedValueOnce({
        id: 'storage-node-789',
      });
      prisma.file.update.mockResolvedValueOnce({ id: 'storage-node-789' });

      const res = await storageService.deleteAsset('storage-node-789');

      expect(res.ok).toBe(true);
      expect(mockStoragePort.deleteFile).toHaveBeenCalledWith(
        'storage-node-789',
      );
      expect(prisma.file.update).toHaveBeenCalledWith({
        where: { id: 'storage-node-789' },
        data: { trashedAt: expect.any(Date) },
      });
    });
  });
});
