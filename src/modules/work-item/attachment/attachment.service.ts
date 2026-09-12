import { Injectable, NotFoundException } from '@nestjs/common';
import { AttachmentService as CoreAttachmentService } from '@/modules/attachment/attachment.service';
import { PrismaService } from '@/core/database/prisma.service';
import { CreateAttachmentDto } from './dto/attachment.dto';
import { EntityType } from '@prisma/client';

@Injectable()
export class AttachmentService {
  constructor(
    private readonly coreAttachmentService: CoreAttachmentService,
    private readonly prismaService: PrismaService,
  ) {}

  async getAttachments(taskId: string) {
    const task = await this.prismaService.task.findUnique({
      where: { id: taskId },
      select: { id: true },
    });
    if (!task) {
      throw new NotFoundException(`Work item ${taskId} not found`);
    }

    const records = await this.coreAttachmentService.getAttachmentsForEntity(
      EntityType.task,
      taskId,
    );

    return {
      taskId,
      total: records.length,
      attachments: records,
    };
  }

  async addAttachment(
    taskId: string,
    createAttachmentDto: CreateAttachmentDto,
    authorId: string,
  ) {
    const task = await this.prismaService.task.findUnique({
      where: { id: taskId },
      select: { id: true, projectId: true },
    });
    if (!task) {
      throw new NotFoundException(`Work item ${taskId} not found`);
    }

    return this.coreAttachmentService.createAttachment(
      {
        entityType: EntityType.task,
        entityId: taskId,
        filename: createAttachmentDto.filename || createAttachmentDto.name || 'attachment',
        url: createAttachmentDto.url,
        storageKey: createAttachmentDto.storageKey,
        size: createAttachmentDto.size || 0,
        mimeType: createAttachmentDto.mimeType || 'application/octet-stream',
        projectId: task.projectId,
        metadata: createAttachmentDto.metadata,
      },
      authorId,
    );
  }

  async removeAttachment(taskId: string, attachmentId: string, authorId: string) {
    const task = await this.prismaService.task.findUnique({
      where: { id: taskId },
      select: { id: true },
    });
    if (!task) {
      throw new NotFoundException(`Work item ${taskId} not found`);
    }

    await this.coreAttachmentService.deleteAttachment(attachmentId, authorId);

    return { success: true, attachmentId };
  }
}
