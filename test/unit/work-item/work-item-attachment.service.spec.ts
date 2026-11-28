import { EntityType } from '@prisma/client';
import { fromPartial } from '@total-typescript/shoehorn';
import type { FastifyRequest } from 'fastify';
import { PrismaService } from '@/core';
import type { IFilesPort } from '@/modules/files/types/files.type';
import { AttachmentRepository } from '@/modules/project/work-item/attachment/attachment.repository';
import { AttachmentService } from '@/modules/project/work-item/attachment/attachment.service';

describe('Work-Item AttachmentService & FilesPort Integration', () => {
  let service: AttachmentService;
  let mockRepo: jest.Mocked<AttachmentRepository>;
  let mockWorkItemFindUnique: jest.Mock;
  let mockWorkItemFindFirst: jest.Mock;
  let mockPrisma: PrismaService;
  let mockFilesPort: jest.Mocked<IFilesPort>;

  beforeEach(() => {
    mockRepo = fromPartial<jest.Mocked<AttachmentRepository>>({
      create: jest.fn(async (dto, authorId) =>
        fromPartial({
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
    });

    mockWorkItemFindUnique = jest.fn();
    mockWorkItemFindFirst = jest.fn();
    mockPrisma = fromPartial<PrismaService>({
      workItem: {
        findUnique: mockWorkItemFindUnique,
        findFirst: mockWorkItemFindFirst,
      },
    });

    mockFilesPort = fromPartial<jest.Mocked<IFilesPort>>({
      uploadFile: jest.fn().mockResolvedValue({
        fileId: 'cas-file-999',
        blobId: 'cas-file-999',
        url: '/api/v1/files/cas-file-999/content',
        path: 'cas/blobs/cas-file-999',
        filename: 'report.pdf',
        size: 1024,
        mimeType: 'application/pdf',
        isDeduplicated: false,
      }),
      deleteFile: jest.fn().mockResolvedValue(undefined),
      deleteObject: jest.fn().mockResolvedValue(undefined),
      presignUpload: jest.fn().mockResolvedValue({
        uploadUrl: 'https://storage-port.example.com/upload',
        storageKey: 'cas-keys/blob-1',
        fileUuid: 'file-uuid-777',
        cleanFilename: 'dataset.csv',
        deduplicated: false,
        expiresIn: 3600,
      }),
    });

    service = new AttachmentService(mockRepo, mockPrisma, mockFilesPort);
  });

  it('uploads multipart attachments via IFilesPort (both explicit fields and params.workItemId fallback) and rejects when storage is absent', async () => {
    const mockBuffer = Buffer.from('PDF_SAMPLE_DATA');
    const explicitReq = fromPartial<FastifyRequest>({
      isMultipart: () => true,
      parts: async function* () {
        yield {
          type: 'file',
          filename: 'research_proposal.pdf',
          mimetype: 'application/pdf',
          toBuffer: async () => mockBuffer,
        };
        yield { type: 'field', fieldname: 'entityType', value: 'work_item' };
        yield { type: 'field', fieldname: 'entityId', value: 'item-uuid-1' };
        yield { type: 'field', fieldname: 'projectId', value: 'proj-uuid-1' };
      } as never,
    });

    const uploaded = await service.uploadMultipart(explicitReq, 'user-uuid-1');
    expect(uploaded.id).toBe('att-123');
    expect(mockFilesPort.uploadFile).toHaveBeenCalledWith({
      userId: 'user-uuid-1',
      filename: 'research_proposal.pdf',
      buffer: mockBuffer,
      mimeType: 'application/pdf',
      spaceId: 'proj-uuid-1',
    });

    // Fallback to req.params.workItemId
    const paramItemId = '22222222-2222-2222-2222-222222222222';
    mockWorkItemFindUnique.mockResolvedValue({
      id: paramItemId,
      projectId: 'proj-resolved-1',
    });
    mockWorkItemFindFirst.mockResolvedValue({
      id: paramItemId,
      projectId: 'proj-resolved-1',
    });

    const paramReq = fromPartial<FastifyRequest>({
      params: { workItemId: paramItemId },
      isMultipart: () => true,
      parts: async function* () {
        yield {
          type: 'file',
          filename: 'figure.png',
          mimetype: 'image/png',
          toBuffer: async () => Buffer.from('CONTENT'),
        };
      } as never,
    });
    const paramUploaded = await service.uploadMultipart(paramReq, 'user-param-1');
    expect(paramUploaded.file?.name).toBe('figure.png');
    expect(mockFilesPort.uploadFile).toHaveBeenLastCalledWith(
      expect.objectContaining({
        spaceId: 'proj-resolved-1',
        filename: 'figure.png',
      }),
    );

    // Missing storage provider throws
    const noStorageService = new AttachmentService(mockRepo, mockPrisma, undefined);
    await expect(
      noStorageService.uploadMultipart(paramReq, 'user-uuid-2'),
    ).rejects.toThrow('Storage provider is not available');
  });

  it('deletes and detaches attachments across metadata.fileId, spaceId attribution, URL-extracted fileId, and legacy storageKey', async () => {
    mockRepo.findById.mockResolvedValueOnce(
      fromPartial({
        id: 'att-123',
        entityType: EntityType.work_item,
        entityId: 'item-uuid-1',
        metadata: { fileId: 'cas-file-999' },
      }),
    );
    await service.deleteAttachment('att-123');
    expect(mockFilesPort.deleteFile).toHaveBeenCalledWith('cas-file-999');

    mockRepo.findById.mockResolvedValueOnce(
      fromPartial({
        id: 'att-proj-1',
        entityType: EntityType.work_item,
        entityId: 'item-uuid-1',
        projectId: 'proj-space-1',
        metadata: { fileId: 'cas-file-proj-1' },
      }),
    );
    await service.deleteAttachment('att-proj-1', 'user-1');
    expect(mockFilesPort.deleteFile).toHaveBeenCalledWith('cas-file-proj-1', {
      spaceId: 'proj-space-1',
    });

    mockRepo.findById.mockResolvedValueOnce(
      fromPartial({
        id: 'att-789',
        entityType: EntityType.work_item,
        entityId: 'item-uuid-1',
        url: '/api/v1/files/cas-url-uuid-555/content',
        metadata: {},
      }),
    );
    await service.deleteAttachment('att-789');
    expect(mockFilesPort.deleteFile).toHaveBeenCalledWith('cas-url-uuid-555');

    mockRepo.findById.mockResolvedValueOnce(
      fromPartial({
        id: 'att-456',
        entityType: EntityType.work_item,
        entityId: 'item-uuid-1',
        storageKey: 'legacy/attachments/old.pdf',
        metadata: {},
      }),
    );
    await service.deleteAttachment('att-456');
    expect(mockFilesPort.deleteObject).toHaveBeenCalledWith(
      'legacy/attachments/old.pdf',
    );

    // detachFile
    const mockItemId = '11111111-1111-1111-1111-111111111111';
    mockWorkItemFindUnique.mockResolvedValue({
      id: mockItemId,
      projectId: 'proj-1',
      columnId: 'col-1',
    });
    mockWorkItemFindFirst.mockResolvedValue({
      id: mockItemId,
      projectId: 'proj-1',
      columnId: 'col-1',
    });
    mockRepo.findByEntity.mockResolvedValueOnce([
      fromPartial({
        id: 'att-file-1',
        entityType: EntityType.work_item,
        entityId: mockItemId,
        metadata: { fileId: 'cas-file-999' },
        url: '/api/v1/files/cas-file-999/content',
      }),
    ]);
    mockRepo.findById.mockResolvedValueOnce(
      fromPartial({
        id: 'att-file-1',
        entityType: EntityType.work_item,
        entityId: mockItemId,
        metadata: { fileId: 'cas-file-999' },
      }),
    );

    const detachRes = await service.detachFile(mockItemId, 'att-file-1');
    expect(detachRes.message).toBe('File detached successfully');
    expect(mockRepo.delete).toHaveBeenCalledWith('att-file-1');
  });

  it('generates presigned upload URLs and rejects when presignUpload is unavailable', async () => {
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
    expect(res.signedUrl).toBe('https://storage-port.example.com/upload');
    expect(res.fileUrl).toBe('/api/v1/files/file-uuid-777/content');

    const serviceWithoutPresign = new AttachmentService(
      mockRepo,
      mockPrisma,
      fromPartial<IFilesPort>({}),
    );
    await expect(
      serviceWithoutPresign.generatePresignedUpload(
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
