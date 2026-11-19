import { AttachmentService } from '@/modules/project/work-item/attachment/attachment.service';
import { AttachmentRepository } from '@/modules/project/work-item/attachment/attachment.repository';
import { PrismaService } from '@/core';
import { IFilesPort } from '@/modules/files';
import { EntityType } from '@prisma/client';

describe('Work-Item AttachmentService & Storage Integration', () => {
  let service: AttachmentService;
  let mockRepo: any;
  let mockPrisma: any;
  let mockFilesPort: any;

  beforeEach(() => {
    mockRepo = {
      create: jest.fn().mockImplementation((dto, authorId) =>
        Promise.resolve({
          id: 'att-123',
          ...dto,
          authorId,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      ),
      findById: jest.fn(),
      delete: jest.fn().mockResolvedValue({ id: 'att-123' }),
      findByEntity: jest.fn().mockResolvedValue([]),
    };

    mockPrisma = {
      workItem: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
      },
    };

    mockFilesPort = {
      uploadFile: jest.fn().mockResolvedValue({
        fileId: 'cas-file-999',
        url: '/api/v1/files/cas-file-999/content',
        path: 'cas/blobs/cas-file-999',
        filename: 'report.pdf',
        size: 1024,
        mimeType: 'application/pdf',
      }),
      readOwnedFile: jest.fn(),
      deleteFile: jest.fn().mockResolvedValue(undefined),
      deleteObject: jest.fn().mockResolvedValue(undefined),
    };

    service = new AttachmentService(
      mockRepo as AttachmentRepository,
      mockPrisma as PrismaService,
      mockFilesPort as IFilesPort,
    );
  });

  describe('uploadMultipart with FILES_PORT', () => {
    it('should route file upload to storagePort and record fileId in metadata', async () => {
      const mockBuffer = Buffer.from('PDF_SAMPLE_DATA');
      const mockReq: any = {
        isMultipart: () => true,
        parts: async function* () {
          yield {
            type: 'file',
            filename: 'research_proposal.pdf',
            mimetype: 'application/pdf',
            toBuffer: async () => mockBuffer,
          };
          yield {
            type: 'field',
            fieldname: 'entityType',
            value: 'work_item',
          };
          yield {
            type: 'field',
            fieldname: 'entityId',
            value: 'item-uuid-1',
          };
          yield {
            type: 'field',
            fieldname: 'projectId',
            value: 'proj-uuid-1',
          };
        },
      };

      const result = await service.uploadMultipart(mockReq, 'user-uuid-1');

      expect(mockFilesPort.uploadFile).toHaveBeenCalledWith({
        userId: 'user-uuid-1',
        filename: 'research_proposal.pdf',
        buffer: mockBuffer,
        mimeType: 'application/pdf',
        spaceId: 'proj-uuid-1',
        source: 'work-item',
      });

      expect(mockRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: 'work_item',
          entityId: 'item-uuid-1',
          filename: 'research_proposal.pdf',
          url: '/api/v1/files/cas-file-999/content',
          storageKey: 'cas/blobs/cas-file-999',
          metadata: expect.objectContaining({
            fileId: 'cas-file-999',
            source: 'work-item',
          }),
        }),
        'user-uuid-1',
      );

      expect(result.id).toBe('att-123');
    });
  });

  describe('uploadMultipart when FILES_PORT is unavailable', () => {
    it('should throw BadRequestException if storagePort is not injected', async () => {
      const serviceWithoutStoragePort = new AttachmentService(
        mockRepo as AttachmentRepository,
        mockPrisma as PrismaService,
        undefined,
      );

      const mockBuffer = Buffer.from('RAW_DATA');
      const mockReq: any = {
        isMultipart: () => true,
        parts: async function* () {
          yield {
            type: 'file',
            filename: 'dataset.csv',
            mimetype: 'text/csv',
            toBuffer: async () => mockBuffer,
          };
          yield {
            type: 'field',
            fieldname: 'entityType',
            value: 'work_item',
          };
          yield {
            type: 'field',
            fieldname: 'entityId',
            value: 'item-uuid-2',
          };
        },
      };

      await expect(
        serviceWithoutStoragePort.uploadMultipart(mockReq, 'user-uuid-2'),
      ).rejects.toThrow('Storage provider is not available');
    });
  });

  describe('deleteAttachment', () => {
    it('should delete from storagePort when fileId is present in metadata', async () => {
      mockRepo.findById!.mockResolvedValueOnce({
        id: 'att-123',
        entityType: EntityType.work_item,
        entityId: 'item-uuid-1',
        metadata: { fileId: 'cas-file-999' },
      } as any);

      await service.deleteAttachment('att-123');

      expect(mockFilesPort.deleteFile).toHaveBeenCalledWith('cas-file-999');
      expect(mockRepo.delete).toHaveBeenCalledWith('att-123');
    });

    it('should pass spaceId when deleting an attachment with projectId', async () => {
      mockRepo.findById!.mockResolvedValueOnce({
        id: 'att-proj-1',
        entityType: EntityType.work_item,
        entityId: 'item-uuid-1',
        projectId: 'proj-space-1',
        metadata: { fileId: 'cas-file-proj-1' },
      } as any);

      await service.deleteAttachment('att-proj-1', 'user-1');

      expect(mockFilesPort.deleteFile).toHaveBeenCalledWith('cas-file-proj-1', {
        spaceId: 'proj-space-1',
      });
      expect(mockRepo.delete).toHaveBeenCalledWith('att-proj-1');
    });

    it('should delete from storagePort when fileId is extracted from URL', async () => {
      mockRepo.findById!.mockResolvedValueOnce({
        id: 'att-789',
        entityType: EntityType.work_item,
        entityId: 'item-uuid-1',
        url: '/api/v1/files/cas-url-uuid-555/content',
        metadata: {},
      } as any);

      await service.deleteAttachment('att-789');

      expect(mockFilesPort.deleteFile).toHaveBeenCalledWith('cas-url-uuid-555');
      expect(mockRepo.delete).toHaveBeenCalledWith('att-789');
    });

    it('should delete via storagePort.deleteObject when only storageKey is present', async () => {
      mockRepo.findById!.mockResolvedValueOnce({
        id: 'att-456',
        entityType: EntityType.work_item,
        entityId: 'item-uuid-1',
        storageKey: 'legacy/attachments/old.pdf',
        metadata: {},
      } as any);

      await service.deleteAttachment('att-456');

      expect(mockFilesPort.deleteObject).toHaveBeenCalledWith(
        'legacy/attachments/old.pdf',
      );
      expect(mockRepo.delete).toHaveBeenCalledWith('att-456');
    });
  });

  describe('detachFile', () => {
    it('should find attachment and invoke deleteAttachment for storage cleanup', async () => {
      const mockItemId = '11111111-1111-1111-1111-111111111111';
      mockPrisma.workItem.findUnique.mockResolvedValue({
        id: mockItemId,
        projectId: 'proj-1',
        columnId: 'col-1',
      });
      mockPrisma.workItem.findFirst.mockResolvedValue({
        id: mockItemId,
        projectId: 'proj-1',
        columnId: 'col-1',
      });
      mockRepo.findByEntity.mockResolvedValueOnce([
        {
          id: 'att-file-1',
          entityType: EntityType.work_item,
          entityId: mockItemId,
          metadata: { fileId: 'cas-file-999' },
          url: '/api/v1/files/cas-file-999/content',
        },
      ]);
      mockRepo.findById.mockResolvedValueOnce({
        id: 'att-file-1',
        entityType: EntityType.work_item,
        entityId: mockItemId,
        metadata: { fileId: 'cas-file-999' },
      });

      const res = await service.detachFile(mockItemId, 'att-file-1');

      expect(mockFilesPort.deleteFile).toHaveBeenCalledWith('cas-file-999');
      expect(mockRepo.delete).toHaveBeenCalledWith('att-file-1');
      expect(res.message).toBe('File detached successfully');
    });
  });

  describe('generatePresignedUpload', () => {
    it('should generate presigned upload URL via storagePort.getPresignedUploadUrl', async () => {
      mockFilesPort.getPresignedUploadUrl = jest.fn().mockResolvedValue({
        uploadUrl: 'https://storage-port.example.com/upload',
        storageKey: 'cas-keys/blob-1',
        fileUuid: 'file-uuid-777',
        expiresIn: 3600,
      });

      const res = await service.generatePresignedUpload(
        {
          entityType: EntityType.work_item,
          entityId: '11111111-1111-1111-1111-111111111111',
          filename: 'dataset.csv',
          contentType: 'text/csv',
          size: 1024,
        },
        'user-1',
      );

      expect(mockFilesPort.getPresignedUploadUrl).toHaveBeenCalled();
      expect(res.signedUrl).toBe('https://storage-port.example.com/upload');
      expect(res.fileUrl).toBe('/api/v1/files/file-uuid-777/content');
    });

    it('should throw BadRequestException when storagePort is not configured for presign', async () => {
      delete mockFilesPort.getPresignedUploadUrl;

      await expect(
        service.generatePresignedUpload(
          {
            entityType: EntityType.work_item,
            entityId: '11111111-1111-1111-1111-111111111111',
            filename: 'large_archive.zip',
            contentType: 'application/zip',
            size: 5 * 1024 * 1024,
          },
          'user-1',
        ),
      ).rejects.toThrow('Object storage direct upload is not configured');
    });
  });

  describe('uploadMultipart with params.workItemId fallback', () => {
    it('should resolve workItemId from req.params when entityId is not in form fields', async () => {
      const mockItemId = '22222222-2222-2222-2222-222222222222';
      mockPrisma.workItem.findUnique.mockResolvedValue({
        id: mockItemId,
        projectId: 'proj-resolved-1',
      });
      mockPrisma.workItem.findFirst.mockResolvedValue({
        id: mockItemId,
        projectId: 'proj-resolved-1',
      });

      const mockBuffer = Buffer.from('CONTENT');
      const mockReq: any = {
        params: { workItemId: mockItemId },
        isMultipart: () => true,
        parts: async function* () {
          yield {
            type: 'file',
            filename: 'figure.png',
            mimetype: 'image/png',
            toBuffer: async () => mockBuffer,
          };
        },
      };

      const result = await service.uploadMultipart(mockReq, 'user-param-1');

      expect(mockFilesPort.uploadFile).toHaveBeenCalledWith(
        expect.objectContaining({
          spaceId: 'proj-resolved-1',
          filename: 'figure.png',
        }),
      );
      expect(result.file).toBeDefined();
      expect(result.file.name).toBe('figure.png');
    });
  });
});
