import { AttachmentService } from '@/modules/work-item/attachment/attachment.service';
import { AttachmentRepository } from '@/modules/work-item/attachment/attachment.repository';
import { PrismaService } from '@/core/database/prisma.service';
import { IStoragePort } from '@/modules/storage/storage.port';
import { EntityType } from '@prisma/client';

describe('Work-Item AttachmentService & Storage Integration', () => {
  let service: AttachmentService;
  let mockRepo: any;
  let mockPrisma: any;
  let mockStoragePort: any;
  let mockR2Service: any;

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

    mockStoragePort = {
      uploadFile: jest.fn().mockResolvedValue({
        fileId: 'cas-file-999',
        url: '/api/files/cas-file-999/content',
        path: 'cas/blobs/cas-file-999',
        filename: 'report.pdf',
        size: 1024,
        mimeType: 'application/pdf',
      }),
      readOwnedFile: jest.fn(),
      deleteFile: jest.fn().mockResolvedValue(undefined),
    };

    mockR2Service = {
      uploadBuffer: jest.fn().mockResolvedValue({
        path: 'attachments/r2-key',
        url: 'https://cdn.example.com/r2-key',
      }),
      deleteObject: jest.fn().mockResolvedValue(undefined),
      getPresignedUploadUrl: jest.fn().mockResolvedValue({
        signedUrl: 'https://upload.example.com',
        path: 'attachments/presigned-key',
        url: 'https://cdn.example.com/presigned-key',
      }),
    };

    service = new AttachmentService(
      mockRepo as AttachmentRepository,
      mockR2Service,
      mockPrisma as PrismaService,
      mockStoragePort as IStoragePort,
    );
  });

  describe('uploadMultipart with STORAGE_PORT', () => {
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

      expect(mockStoragePort.uploadFile).toHaveBeenCalledWith({
        userId: 'user-uuid-1',
        filename: 'research_proposal.pdf',
        buffer: mockBuffer,
        mimeType: 'application/pdf',
        projectId: 'proj-uuid-1',
        source: 'work-item',
      });

      expect(mockRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: 'work_item',
          entityId: 'item-uuid-1',
          filename: 'research_proposal.pdf',
          url: '/api/files/cas-file-999/content',
          storageKey: 'cas/blobs/cas-file-999',
          metadata: {
            fileId: 'cas-file-999',
            source: 'work-item',
          },
        }),
        'user-uuid-1',
      );

      expect(result.id).toBe('att-123');
    });
  });

  describe('uploadMultipart fallback to R2Service', () => {
    it('should fallback to r2Service if storagePort is not injected', async () => {
      const serviceWithoutStoragePort = new AttachmentService(
        mockRepo as AttachmentRepository,
        mockR2Service,
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

      await serviceWithoutStoragePort.uploadMultipart(mockReq, 'user-uuid-2');

      expect(mockR2Service.uploadBuffer).toHaveBeenCalled();
      expect(mockRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          filename: 'dataset.csv',
          storageKey: 'attachments/r2-key',
        }),
        'user-uuid-2',
      );
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

      expect(mockStoragePort.deleteFile).toHaveBeenCalledWith('cas-file-999');
      expect(mockRepo.delete).toHaveBeenCalledWith('att-123');
    });

    it('should delete from r2Service when only storageKey is present', async () => {
      mockRepo.findById!.mockResolvedValueOnce({
        id: 'att-456',
        entityType: EntityType.work_item,
        entityId: 'item-uuid-1',
        storageKey: 'legacy/attachments/old.pdf',
        metadata: {},
      } as any);

      await service.deleteAttachment('att-456');

      expect(mockR2Service.deleteObject).toHaveBeenCalledWith('legacy/attachments/old.pdf');
      expect(mockRepo.delete).toHaveBeenCalledWith('att-456');
    });
  });

  describe('generatePresignedUpload', () => {
    it('should delegate to r2Service for direct client uploads', async () => {
      const res = await service.generatePresignedUpload(
        {
          entityType: EntityType.work_item,
          entityId: 'item-uuid-1',
          filename: 'large_archive.zip',
          contentType: 'application/zip',
          size: 5 * 1024 * 1024,
        },
        'user-1',
      );

      expect(mockR2Service.getPresignedUploadUrl).toHaveBeenCalled();
      expect(res.signedUrl).toBe('https://upload.example.com');
      expect(res.fileUrl).toBe('https://cdn.example.com/presigned-key');
    });
  });
});
