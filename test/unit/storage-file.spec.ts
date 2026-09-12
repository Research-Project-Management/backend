import {
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { FileService } from '@/modules/storage/file/file.service';
import { FileRepository } from '@/modules/storage/file/file.repository';
import { R2Service } from '@/modules/storage/r2/r2.service';
import { PrismaService } from '@/core/database/prisma.service';
import { EventEmitter2 } from '@nestjs/event-emitter';

describe('Storage Module — FileService Unit Tests', () => {
  let service: FileService;
  let mockFileRepo: any;
  let mockR2Service: any;
  let mockPrisma: any;
  let mockEventEmitter: any;
  let mockCache: any;

  const mockProjectId = 'proj-storage-123';
  const mockCreatorId = 'user-creator-1';
  const mockContributorId = 'user-contrib-2';
  const mockViewerId = 'user-viewer-3';
  const mockStrangerId = 'user-stranger-4';
  const mockPageId = 'page-doc-123';
  const mockFileId = 'file-123';

  beforeEach(() => {
    mockFileRepo = {
      createFile: jest.fn(),
      findFileById: jest.fn(),
      findFileByKey: jest.fn(),
      findFiles: jest.fn(),
      findProjectFiles: jest.fn(),
      findProjectFolderTree: jest.fn(),
      findUserStarredFiles: jest.fn(),
      findFileShares: jest.fn(),
      getFileShares: jest.fn(),
      updateFile: jest.fn(),
      trashFile: jest.fn(),
      restoreFile: jest.fn(),
      deleteFile: jest.fn(),
      findPageScope: jest.fn(),
      findProjectScope: jest.fn(),
      findProjectMemberRole: jest.fn(),
      calculateUserStorageUsage: jest.fn(),
    };

    mockR2Service = {
      uploadBuffer: jest.fn(),
      deleteObject: jest.fn(),
      getPresignedUploadUrl: jest.fn(),
      getObjectStream: jest.fn(),
    };

    mockPrisma = {
      file: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      attachment: {
        count: jest.fn().mockResolvedValue(0),
      },
      item: {
        findUnique: jest.fn(),
      },
      project: {
        findUnique: jest.fn().mockResolvedValue({ workspaceId: 'ws-123' }),
        findFirst: jest.fn().mockResolvedValue({ workspaceId: 'ws-123' }),
      },
      projectMember: {
        findFirst: jest.fn().mockResolvedValue({ project: { workspaceId: 'ws-123' } }),
      },
      page: {
        findUnique: jest.fn().mockResolvedValue({ project: { workspaceId: 'ws-123' } }),
      },
    };

    mockEventEmitter = {
      emit: jest.fn(),
    };

    mockCache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
      delPattern: jest.fn().mockResolvedValue(1),
    };

    service = new FileService(
      mockFileRepo as unknown as FileRepository,
      mockR2Service as unknown as R2Service,
      mockPrisma as unknown as PrismaService,
      mockEventEmitter as unknown as EventEmitter2,
      mockCache,
    );
  });

  describe('assertCanWriteScope & upload', () => {
    it('allows user to upload personal/highest scope file', async () => {
      mockFileRepo.createFile.mockResolvedValue({
        id: 'new-file-1',
        filename: 'dataset.csv',
        isFolder: false,
        size: 1024,
        mimeType: 'text/csv',
        url: 'https://cdn.example.com/dataset.csv',
        authorId: mockCreatorId,
        linkedToType: 'Personal',
        linkedToId: mockCreatorId,
      });

      const result = await service.upload(
        mockCreatorId,
        {},
        { filename: 'dataset.csv', size: 1024, mimeType: 'text/csv' },
      );

      expect(result.file?.id).toBe('new-file-1');
      expect(result.file?.filename).toBe('dataset.csv');
      expect(mockFileRepo.createFile).toHaveBeenCalled();
    });

    it('allows personal file upload when no pageId is given', async () => {
      mockFileRepo.createFile.mockResolvedValue({
        id: 'personal-file-1',
        filename: 'notes.txt',
        isFolder: false,
        authorId: mockCreatorId,
        linkedToType: 'Personal',
        linkedToId: mockCreatorId,
      });

      const result = await service.upload(
        mockCreatorId,
        {},
        { filename: 'notes.txt' },
      );

      expect(result.file?.id).toBe('personal-file-1');
    });

    it('allows upload to page when page exists', async () => {
      mockFileRepo.findPageScope.mockResolvedValue({
        id: mockPageId,
        projectId: mockProjectId,
      });
      mockFileRepo.createFile.mockResolvedValue({
        id: 'page-file-1',
        filename: 'figure1.png',
        authorId: mockContributorId,
        linkedToType: 'Page',
        linkedToId: mockPageId,
      });

      const result = await service.upload(
        mockContributorId,
        { pageId: mockPageId },
        { filename: 'figure1.png' },
      );

      expect(result.file?.id).toBe('page-file-1');
    });

    it('throws NotFoundException when page does not exist', async () => {
      mockFileRepo.findPageScope.mockResolvedValue(null);

      await expect(
        service.upload(
          mockContributorId,
          { pageId: 'missing-page' },
          { filename: 'figure1.png' },
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('assertCanAccessFile', () => {
    it('grants full access to author', async () => {
      mockFileRepo.findFileById.mockResolvedValue({
        id: mockFileId,
        authorId: mockCreatorId,
        linkedToType: 'Project',
        linkedToId: mockProjectId,
      });

      const file = await service.assertCanAccessFile(
        mockCreatorId,
        mockFileId,
        'write',
      );
      expect(file.id).toBe(mockFileId);
    });

    it('grants write access to user with direct edit share', async () => {
      mockFileRepo.findFileById.mockResolvedValue({
        id: mockFileId,
        authorId: mockCreatorId,
        sharedWith: [{ userId: mockContributorId, permission: 'edit' }],
      });

      const file = await service.assertCanAccessFile(
        mockContributorId,
        mockFileId,
        'write',
      );
      expect(file.id).toBe(mockFileId);
    });

    it('blocks user with direct view share from write access', async () => {
      mockFileRepo.findFileById.mockResolvedValue({
        id: mockFileId,
        authorId: mockCreatorId,
        sharedWith: [{ userId: mockViewerId, permission: 'view' }],
      });

      await expect(
        service.assertCanAccessFile(mockViewerId, mockFileId, 'write'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('grants write access to project creator for project files', async () => {
      mockFileRepo.findFileById.mockResolvedValue({
        id: mockFileId,
        authorId: 'some-other-author',
        linkedToType: 'Project',
        linkedToId: mockProjectId,
      });
      mockFileRepo.findProjectScope.mockResolvedValue({
        id: mockProjectId,
        createdById: mockCreatorId,
      });

      const file = await service.assertCanAccessFile(
        mockCreatorId,
        mockFileId,
        'write',
      );
      expect(file.id).toBe(mockFileId);
    });

    it('blocks stranger from accessing file', async () => {
      mockFileRepo.findFileById.mockResolvedValue({
        id: mockFileId,
        authorId: mockCreatorId,
        linkedToType: 'Project',
        linkedToId: mockProjectId,
      });
      mockFileRepo.findProjectScope.mockResolvedValue({
        id: mockProjectId,
        createdById: mockCreatorId,
      });
      mockFileRepo.findProjectMemberRole.mockResolvedValue(null);

      await expect(
        service.assertCanAccessFile(mockStrangerId, mockFileId, 'read'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws NotFoundException when file does not exist', async () => {
      mockFileRepo.findFileById.mockResolvedValue(null);

      await expect(
        service.assertCanAccessFile(mockCreatorId, 'non-existent', 'read'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('File Management Operations', () => {
    it('renames file successfully', async () => {
      mockFileRepo.findFileById.mockResolvedValue({
        id: mockFileId,
        authorId: mockCreatorId,
      });
      mockFileRepo.updateFile.mockResolvedValue({
        id: mockFileId,
        filename: 'renamed.pdf',
        authorId: mockCreatorId,
      });

      const result = await service.renameFile(
        mockFileId,
        mockCreatorId,
        'renamed.pdf',
      );
      expect(result.file?.filename).toBe('renamed.pdf');
    });

    it('moves file to a parent folder', async () => {
      mockFileRepo.findFileById
        .mockResolvedValueOnce({
          id: mockFileId,
          authorId: mockCreatorId,
          linkedToType: 'Project',
          linkedToId: mockProjectId,
        })
        .mockResolvedValueOnce({
          id: 'folder-target-1',
          isFolder: true,
          authorId: mockCreatorId,
          linkedToType: 'Project',
          linkedToId: mockProjectId,
        });

      mockFileRepo.updateFile.mockResolvedValue({
        id: mockFileId,
        parentId: 'folder-target-1',
        authorId: mockCreatorId,
      });

      const result = await service.moveFile(
        mockFileId,
        mockCreatorId,
        'folder-target-1',
      );
      expect(result.file?.parentId).toBe('folder-target-1');
    });

    it('soft deletes file', async () => {
      mockFileRepo.findFileById.mockResolvedValue({
        id: mockFileId,
        authorId: mockCreatorId,
      });
      mockFileRepo.trashFile.mockResolvedValue({
        id: mockFileId,
        trashedAt: new Date(),
      });

      const result = await service.deleteFile(mockFileId, mockCreatorId);
      expect(result.message).toBe('File moved to trash');
    });

    it('restores file from trash', async () => {
      mockFileRepo.findFileById.mockResolvedValue({
        id: mockFileId,
        authorId: mockCreatorId,
        trashedAt: new Date(),
      });
      mockFileRepo.restoreFile.mockResolvedValue({
        id: mockFileId,
        trashedAt: null,
      });

      const result = await service.restoreFile(mockFileId, mockCreatorId);
      expect(result.message).toBe('File restored successfully');
    });

    it('permanently deletes file from storage and R2', async () => {
      mockFileRepo.findFileById.mockResolvedValue({
        id: mockFileId,
        authorId: mockCreatorId,
        url: 'https://cdn.example.com/api/files/r2/uploads/test.pdf',
      });
      mockFileRepo.deleteFile.mockResolvedValue({
        id: mockFileId,
      });

      const result = await service.permanentlyDeleteFile(
        mockFileId,
        mockCreatorId,
      );
      expect(result.message).toBe('File permanently deleted');
      expect(mockFileRepo.deleteFile).toHaveBeenCalledWith(mockFileId);
    });
  });

  describe('getUserStorageUsage', () => {
    it('returns calculated bytes for user', async () => {
      mockFileRepo.calculateUserStorageUsage.mockResolvedValue(10485760); // 10MB

      const result = await service.getUserStorageUsage(mockCreatorId);
      expect(result.totalBytes).toBe(10485760);
    });
  });

  describe('User Listing Queries (Highest Scope)', () => {
    it('returns user files in getMyFiles', async () => {
      mockFileRepo.findFiles.mockResolvedValue([
        { id: 'f1', filename: 'file1.txt', authorId: mockCreatorId },
      ]);
      const result = await service.getMyFiles(mockCreatorId);
      expect(result.files).toHaveLength(1);
      expect(result.files[0].id).toBe('f1');
    });

    it('returns starred files in getStarredFiles', async () => {
      mockFileRepo.findFiles.mockResolvedValue([
        { id: 'f2', filename: 'starred.pdf', authorId: mockCreatorId, starred: true },
      ]);
      const result = await service.getStarredFiles(mockCreatorId);
      expect(result.files).toHaveLength(1);
      expect(result.files[0].id).toBe('f2');
    });

    it('returns trashed files in getTrashedFiles', async () => {
      mockFileRepo.findFiles.mockResolvedValue([
        { id: 'f3', filename: 'trashed.png', authorId: mockCreatorId, trashedAt: new Date() },
      ]);
      const result = await service.getTrashedFiles(mockCreatorId);
      expect(result.files).toHaveLength(1);
      expect(result.files[0].id).toBe('f3');
    });
  });
});
