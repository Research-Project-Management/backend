import { NotFoundException } from '@nestjs/common';
import { AttachmentService } from '@/modules/work-item/attachment/attachment.service';
import { AttachmentRepository } from '@/modules/work-item/attachment/attachment.repository';
import { R2Service } from '@/modules/storage/r2/r2.service';
import { PrismaService } from '@/core/database/prisma.service';
import { EntityType } from '@prisma/client';

describe('Work Item Attachment Module', () => {
  let service: AttachmentService;
  let mockRepo: {
    findByEntity: jest.Mock;
    create: jest.Mock;
    delete: jest.Mock;
    findById: jest.Mock;
  };
  let mockR2Service: {
    deleteObject: jest.Mock;
    getPresignedUploadUrl: jest.Mock;
    uploadBuffer: jest.Mock;
  };
  let mockPrisma: {
    workItem: {
      findUnique: jest.Mock;
      update: jest.Mock;
    };
  };

  const taskId = 'task-uuid-1';
  const projectId = 'proj-uuid-1';
  const authorId = 'user-uuid-1';

  beforeEach(() => {
    mockRepo = {
      findByEntity: jest.fn(),
      create: jest.fn(),
      delete: jest.fn(),
      findById: jest.fn(),
    };

    mockR2Service = {
      deleteObject: jest.fn(),
      getPresignedUploadUrl: jest.fn(),
      uploadBuffer: jest.fn(),
    };

    mockPrisma = {
      workItem: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };

    service = new AttachmentService(
      mockRepo as unknown as AttachmentRepository,
      mockR2Service as unknown as R2Service,
      mockPrisma as unknown as PrismaService,
    );
  });

  describe('getAttachments', () => {
    it('should throw NotFoundException if WorkItem does not exist', async () => {
      mockPrisma.workItem.findUnique.mockResolvedValue(null);

      await expect(service.getAttachments(taskId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should return entity attachments for the task', async () => {
      mockPrisma.workItem.findUnique.mockResolvedValue({ id: taskId });

      const records = [
        { id: 'att-1', filename: 'paper-draft.pdf' },
        { id: 'att-2', filename: 'experiment-data.csv' },
      ];
      mockRepo.findByEntity.mockResolvedValue(records);

      const result = await service.getAttachments(taskId);

      expect(mockRepo.findByEntity).toHaveBeenCalledWith(
        EntityType.task,
        taskId,
      );
      expect(result.taskId).toBe(taskId);
      expect(result.total).toBe(2);
      expect(result.attachments).toEqual(records);
    });
  });

  describe('addAttachment', () => {
    it('should throw NotFoundException if WorkItem does not exist', async () => {
      mockPrisma.workItem.findUnique.mockResolvedValue(null);

      await expect(
        service.addAttachment(
          taskId,
          { filename: 'doc.pdf', url: 'https://r2/doc.pdf' },
          authorId,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('should create attachment in entity_attachments table', async () => {
      mockPrisma.workItem.findUnique.mockResolvedValue({
        id: taskId,
        projectId,
      });

      const createdRecord = {
        id: 'new-att-id',
        filename: 'doc.pdf',
        url: 'https://r2/doc.pdf',
        entityType: EntityType.task,
        entityId: taskId,
      };
      mockRepo.create.mockResolvedValue(createdRecord);

      const res = await service.addAttachment(
        taskId,
        { filename: 'doc.pdf', url: 'https://r2/doc.pdf', size: 1024 },
        authorId,
      );

      expect(res).toEqual(createdRecord);
      expect(mockRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: EntityType.task,
          entityId: taskId,
          filename: 'doc.pdf',
          url: 'https://r2/doc.pdf',
          projectId,
        }),
        authorId,
      );
    });

    it('should fallback to name if filename is omitted', async () => {
      mockPrisma.workItem.findUnique.mockResolvedValue({
        id: taskId,
        projectId,
      });

      mockRepo.create.mockResolvedValue({ id: 'att-x' });

      await service.addAttachment(
        taskId,
        { name: 'legacy-name.png', url: 'https://r2/legacy-name.png' },
        authorId,
      );

      expect(mockRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          filename: 'legacy-name.png',
        }),
        authorId,
      );
    });
  });

  describe('removeAttachment', () => {
    it('should throw NotFoundException if WorkItem does not exist', async () => {
      mockPrisma.workItem.findUnique.mockResolvedValue(null);

      await expect(
        service.removeAttachment(taskId, 'att-1', authorId),
      ).rejects.toThrow(NotFoundException);
    });

    it('should delete from attachment repository and storage', async () => {
      mockPrisma.workItem.findUnique.mockResolvedValue({ id: taskId });
      mockRepo.findById.mockResolvedValue({
        id: 'att-1',
        storageKey: 'attachments/task/1/doc.pdf',
      });
      mockRepo.delete.mockResolvedValue({ id: 'att-1' });

      const res = await service.removeAttachment(taskId, 'att-1', authorId);

      expect(res).toEqual({ success: true, id: 'att-1' });
      expect(mockR2Service.deleteObject).toHaveBeenCalledWith(
        'attachments/task/1/doc.pdf',
      );
      expect(mockRepo.delete).toHaveBeenCalledWith('att-1');
    });
  });
});
