import { NotFoundException } from '@nestjs/common';
import { AttachmentService } from '@/modules/work-item/attachment/attachment.service';
import { AttachmentService as CoreAttachmentService } from '@/modules/attachment/attachment.service';
import { PrismaService } from '@/core/database/prisma.service';
import { EntityType } from '@prisma/client';

describe('Work Item Attachment Module', () => {
  let service: AttachmentService;
  let mockCoreAttachmentService: {
    getAttachmentsForEntity: jest.Mock;
    createAttachment: jest.Mock;
    deleteAttachment: jest.Mock;
  };
  let mockPrisma: {
    task: {
      findUnique: jest.Mock;
      update: jest.Mock;
    };
  };

  const taskId = 'task-uuid-1';
  const projectId = 'proj-uuid-1';
  const authorId = 'user-uuid-1';

  beforeEach(() => {
    mockCoreAttachmentService = {
      getAttachmentsForEntity: jest.fn(),
      createAttachment: jest.fn(),
      deleteAttachment: jest.fn(),
    };

    mockPrisma = {
      task: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };

    service = new AttachmentService(
      mockCoreAttachmentService as unknown as CoreAttachmentService,
      mockPrisma as unknown as PrismaService,
    );
  });

  describe('getAttachments', () => {
    it('should throw NotFoundException if task does not exist', async () => {
      mockPrisma.task.findUnique.mockResolvedValue(null);

      await expect(service.getAttachments(taskId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should return entity attachments for the task', async () => {
      mockPrisma.task.findUnique.mockResolvedValue({ id: taskId });

      const records = [
        { id: 'att-1', filename: 'paper-draft.pdf' },
        { id: 'att-2', filename: 'experiment-data.csv' },
      ];
      mockCoreAttachmentService.getAttachmentsForEntity.mockResolvedValue(records);

      const result = await service.getAttachments(taskId);

      expect(mockCoreAttachmentService.getAttachmentsForEntity).toHaveBeenCalledWith(
        EntityType.task,
        taskId,
      );
      expect(result.taskId).toBe(taskId);
      expect(result.total).toBe(2);
      expect(result.attachments).toEqual(records);
    });
  });

  describe('addAttachment', () => {
    it('should throw NotFoundException if task does not exist', async () => {
      mockPrisma.task.findUnique.mockResolvedValue(null);

      await expect(
        service.addAttachment(
          taskId,
          { filename: 'doc.pdf', url: 'https://r2/doc.pdf' },
          authorId,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('should create attachment in entity_attachments table', async () => {
      mockPrisma.task.findUnique.mockResolvedValue({
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
      mockCoreAttachmentService.createAttachment.mockResolvedValue(createdRecord);

      const res = await service.addAttachment(
        taskId,
        { filename: 'doc.pdf', url: 'https://r2/doc.pdf', size: 1024 },
        authorId,
      );

      expect(res).toEqual(createdRecord);
      expect(mockCoreAttachmentService.createAttachment).toHaveBeenCalledWith(
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
      mockPrisma.task.findUnique.mockResolvedValue({
        id: taskId,
        projectId,
      });

      mockCoreAttachmentService.createAttachment.mockResolvedValue({ id: 'att-x' });

      await service.addAttachment(
        taskId,
        { name: 'legacy-name.png', url: 'https://r2/legacy-name.png' },
        authorId,
      );

      expect(mockCoreAttachmentService.createAttachment).toHaveBeenCalledWith(
        expect.objectContaining({
          filename: 'legacy-name.png',
        }),
        authorId,
      );
    });
  });

  describe('removeAttachment', () => {
    it('should throw NotFoundException if task does not exist', async () => {
      mockPrisma.task.findUnique.mockResolvedValue(null);

      await expect(
        service.removeAttachment(taskId, 'att-1', authorId),
      ).rejects.toThrow(NotFoundException);
    });

    it('should delete from core attachment service', async () => {
      mockPrisma.task.findUnique.mockResolvedValue({ id: taskId });
      mockCoreAttachmentService.deleteAttachment.mockResolvedValue(true);

      const res = await service.removeAttachment(taskId, 'att-1', authorId);

      expect(res).toEqual({ success: true, attachmentId: 'att-1' });
      expect(mockCoreAttachmentService.deleteAttachment).toHaveBeenCalledWith(
        'att-1',
        authorId,
      );
    });
  });
});
