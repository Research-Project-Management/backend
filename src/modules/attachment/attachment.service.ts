import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { FastifyRequest } from 'fastify';
import { AttachmentRepository } from './attachment.repository';
import { R2Service } from '@/modules/storage/r2/r2.service';
import { PresignAttachmentDto } from './dto/presign-attachment.dto';
import { CreateAttachmentDto } from './dto/create-attachment.dto';
import { QueryAttachmentDto } from './dto/query-attachment.dto';
import { PresignedAttachmentResponse } from './types/attachment.types';
import { EntityType } from '@prisma/client';

@Injectable()
export class AttachmentService {
  private readonly logger = new Logger(AttachmentService.name);

  constructor(
    private readonly repository: AttachmentRepository,
    private readonly r2Service: R2Service,
    @Optional() private readonly eventEmitter?: EventEmitter2,
  ) {}

  /**
   * Generates a presigned upload URL for direct cloud upload (R2/S3).
   */
  async generatePresignedUpload(
    dto: PresignAttachmentDto,
    userId: string,
  ): Promise<PresignedAttachmentResponse> {
    if (dto.size && dto.size > 100 * 1024 * 1024) {
      throw new BadRequestException('Attachment size exceeds 100MB limit');
    }

    const cleanName = dto.filename.replace(/[^a-zA-Z0-9.-]/g, '_');
    const storageKey = `attachments/${dto.entityType}/${dto.entityId}/${Date.now()}-${cleanName}`;
    const contentType = dto.contentType || 'application/octet-stream';

    const presigned = await this.r2Service.getPresignedUploadUrl(
      storageKey,
      contentType,
      3600,
    );

    return {
      signedUrl: presigned.signedUrl,
      storageKey: presigned.path,
      fileUrl: presigned.url,
      entityType: dto.entityType,
      entityId: dto.entityId,
    };
  }

  /**
   * Direct multipart file upload streaming into storage and recording metadata.
   */
  async uploadMultipart(req: FastifyRequest, authorId: string) {
    const fastifyReq = req as any;
    if (!fastifyReq.isMultipart?.()) {
      throw new BadRequestException('Content-Type must be multipart/form-data');
    }

    const parts = fastifyReq.parts();
    let buffer: Buffer | null = null;
    let filename = 'attachment';
    let mimeType = 'application/octet-stream';
    const fields: Record<string, string> = {};

    for await (const part of parts) {
      if (part.type === 'file') {
        filename = part.filename;
        mimeType = part.mimetype;
        buffer = await part.toBuffer();
      } else {
        fields[part.fieldname] = String(part.value);
      }
    }

    if (!buffer) {
      throw new BadRequestException('No file payload found in multipart request');
    }

    const rawEntityType = fields.entityType || 'task';
    const entityId = fields.entityId;
    if (!entityId) {
      throw new BadRequestException('entityId is required in multipart form data');
    }

    const entityType = rawEntityType as EntityType;
    const cleanName = filename.replace(/[^a-zA-Z0-9.-]/g, '_');
    const storageKey = `attachments/${entityType}/${entityId}/${Date.now()}-${cleanName}`;

    const uploadRes = await this.r2Service.uploadBuffer(
      storageKey,
      buffer,
      mimeType,
    );

    const attachment = await this.repository.create(
      {
        entityType,
        entityId,
        filename,
        url: uploadRes.url,
        storageKey: uploadRes.path,
        size: buffer.length,
        mimeType,
        workspaceId: fields.workspaceId,
        projectId: fields.projectId,
      },
      authorId,
    );

    this.eventEmitter?.emit('attachment.created', {
      attachmentId: attachment.id,
      entityType,
      entityId,
      authorId,
    });

    return attachment;
  }

  /**
   * Commits attachment metadata after client direct upload.
   */
  async createAttachment(dto: CreateAttachmentDto, authorId: string) {
    const attachment = await this.repository.create(dto, authorId);

    this.eventEmitter?.emit('attachment.created', {
      attachmentId: attachment.id,
      entityType: dto.entityType,
      entityId: dto.entityId,
      authorId,
    });

    return attachment;
  }

  /**
   * Retrieves list of attachments matching filters.
   */
  async getAttachments(query: QueryAttachmentDto) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 50;
    const skip = (page - 1) * limit;

    return this.repository.findMany(
      {
        entityType: query.entityType,
        entityId: query.entityId,
        workspaceId: query.workspaceId,
        projectId: query.projectId,
      },
      skip,
      limit,
    );
  }

  /**
   * Retrieves all attachments for a specific entity.
   */
  async getAttachmentsForEntity(entityType: EntityType, entityId: string) {
    return this.repository.findByEntity(entityType, entityId);
  }

  /**
   * Retrieves a single attachment by ID.
   */
  async getAttachmentById(id: string) {
    const attachment = await this.repository.findById(id);
    if (!attachment) {
      throw new NotFoundException(`Attachment ${id} not found`);
    }
    return attachment;
  }

  /**
   * Deletes an attachment from database and underlying storage.
   */
  async deleteAttachment(id: string, authorId?: string) {
    const attachment = await this.repository.findById(id);
    if (!attachment) {
      throw new NotFoundException(`Attachment ${id} not found`);
    }

    if (attachment.storageKey) {
      try {
        await this.r2Service.deleteObject(attachment.storageKey);
      } catch (err: any) {
        this.logger.warn(
          `Failed to delete storage object ${attachment.storageKey}: ${err.message}`,
        );
      }
    }

    await this.repository.delete(id);

    this.eventEmitter?.emit('attachment.deleted', {
      attachmentId: id,
      entityType: attachment.entityType,
      entityId: attachment.entityId,
      authorId,
    });

    return { success: true, id };
  }
}
