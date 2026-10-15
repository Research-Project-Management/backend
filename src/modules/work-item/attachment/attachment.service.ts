import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  Optional,
  Inject,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { FastifyRequest } from 'fastify';
import { AttachmentRepository } from './attachment.repository';
import { R2Service } from '@/modules/storage/infrastructure/drivers/r2.service';
import { STORAGE_PORT, IStoragePort } from '@/modules/storage/storage.port';
import { PrismaService, isUuid } from '@/core';
import {
  AddAttachmentDto,
  AttachPageDto,
  AttachPaperDto,
  AttachFileDto,
  AttachLinkDto,
} from './dto/attachment.dto';
import { CreateAttachmentDto } from './dto/create-attachment.dto';
import { PresignAttachmentDto } from './dto/presign-attachment.dto';
import { QueryAttachmentDto } from './dto/query-attachment.dto';
import { PresignedAttachmentResponse } from './types/attachment.types';
import { EntityType } from '@prisma/client';
import { formatWorkItem } from '@/modules/work-item/core/utils/work-item.util';
import {
  formatEntityAttachments,
  getAttachmentMeta,
} from '@/modules/work-item/core/utils/attachment-format.util';
import { USER_MINIMAL_SELECT } from '@/modules/work-item/common/types/shared.types';

@Injectable()
export class AttachmentService {
  private readonly logger = new Logger(AttachmentService.name);

  constructor(
    private readonly repository: AttachmentRepository,
    @Optional() private readonly r2Service: R2Service,
    private readonly prismaService: PrismaService,
    @Optional()
    @Inject(STORAGE_PORT)
    private readonly storagePort?: IStoragePort,
    @Optional() private readonly eventEmitter?: EventEmitter2,
  ) {}

  private async findWorkItem(workItemId: string) {
    if (this.repository.findWorkItem) {
      const found = await this.repository.findWorkItem(workItemId);
      if (found) return found;
    }
    if (!this.prismaService?.workItem) return null;
    if (isUuid(workItemId) || !this.prismaService.workItem.findFirst) {
      return this.prismaService.workItem.findUnique({
        where: { id: workItemId },
        select: { id: true, projectId: true },
      });
    }
    return this.prismaService.workItem.findFirst({
      where: {
        identifier: { equals: workItemId, mode: 'insensitive' },
        deletedAt: null,
      },
      select: { id: true, projectId: true },
    });
  }

  private async requireWorkItem(workItemId: string) {
    const workItem = await this.findWorkItem(workItemId);
    if (!workItem) {
      throw new NotFoundException(`Work item ${workItemId} not found`);
    }
    return workItem;
  }

  private emitAttachmentEvent(
    event: 'attachment.created' | 'attachment.deleted',
    payload: {
      attachmentId: string;
      entityType: EntityType;
      entityId: string;
      authorId?: string;
    },
  ) {
    this.eventEmitter?.emit(event, payload);
  }

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

    if (this.storagePort?.getPresignedUploadUrl) {
      try {
        const presigned = await this.storagePort.getPresignedUploadUrl({
          userId,
          filename: cleanName,
          mimeType: contentType,
          sizeBytes: dto.size || 0,
        });
        return {
          signedUrl: presigned.uploadUrl,
          storageKey: presigned.storageKey,
          fileUrl: `/api/files/${presigned.fileUuid}/content`,
          entityType: dto.entityType,
          entityId: dto.entityId,
        };
      } catch (err: unknown) {
        this.logger.warn(
          `storagePort.getPresignedUploadUrl failed, falling back to r2Service: ${(err as Error).message}`,
        );
      }
    }

    if (this.r2Service?.getPresignedUploadUrl) {
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

    throw new BadRequestException(
      'Object storage direct upload is not configured',
    );
  }

  /**
   * Direct multipart file upload streaming into storage and recording metadata.
   */
  async uploadMultipart(req: FastifyRequest, authorId: string) {
    if (!req.isMultipart?.()) {
      throw new BadRequestException('Content-Type must be multipart/form-data');
    }

    let buffer: Buffer | null = null;
    let filename = 'attachment';
    let mimeType = 'application/octet-stream';
    const fields: Record<string, string> = {};

    for await (const part of req.parts()) {
      if (part.type === 'file') {
        filename = part.filename;
        mimeType = part.mimetype;
        buffer = await part.toBuffer();
      } else {
        fields[part.fieldname] = String(part.value);
      }
    }

    if (!buffer) {
      throw new BadRequestException(
        'No file payload found in multipart request',
      );
    }

    const params = req.params as Record<string, string | undefined> | undefined;
    const entityId = fields.entityId || params?.workItemId || params?.id;
    if (!entityId) {
      throw new BadRequestException(
        'entityId is required in multipart form data or URL parameter',
      );
    }

    const entityType = (fields.entityType || 'work_item') as EntityType;
    let resolvedEntityId = entityId;
    let resolvedProjectId = fields.projectId;

    if (entityType === EntityType.work_item) {
      const workItem = await this.findWorkItem(entityId);
      if (workItem) {
        resolvedEntityId = workItem.id;
        resolvedProjectId ||= workItem.projectId;
      }
    }

    const cleanName = filename.replace(/[^a-zA-Z0-9.-]/g, '_');
    const storageKey = `attachments/${entityType}/${resolvedEntityId}/${Date.now()}-${cleanName}`;

    let url = '';
    let finalKey = storageKey;
    let fileId: string | undefined;

    if (this.storagePort) {
      const uploadRes = await this.storagePort.uploadFile({
        userId: authorId,
        filename,
        buffer,
        mimeType,
        projectId: resolvedProjectId,
        source: 'work-item',
      });
      url = uploadRes.url;
      finalKey = uploadRes.path;
      fileId = uploadRes.fileId;
    } else if (this.r2Service) {
      const uploadRes = await this.r2Service.uploadBuffer(
        storageKey,
        buffer,
        mimeType,
      );
      url = uploadRes.url;
      finalKey = uploadRes.path;
    } else {
      throw new BadRequestException('Storage provider is not available');
    }

    const attachment = await this.repository.create(
      {
        entityType,
        entityId: resolvedEntityId,
        filename,
        url,
        storageKey: finalKey,
        size: buffer.length,
        mimeType,
        projectId: resolvedProjectId,
        metadata: {
          ...(fileId ? { fileId } : {}),
          source: 'work-item',
          category: 'file',
          name: filename,
        },
      },
      authorId,
    );

    this.emitAttachmentEvent('attachment.created', {
      attachmentId: attachment.id,
      entityType,
      entityId: resolvedEntityId,
      authorId,
    });

    return {
      ...attachment,
      id: attachment.id,
      file: {
        id: attachment.id,
        name: filename,
        filename,
        url,
        size: buffer.length,
        type: mimeType,
        mimeType,
        fileId,
        createdAt: attachment.createdAt,
      },
    };
  }

  /**
   * Commits attachment metadata after client direct upload.
   */
  async createAttachment(dto: CreateAttachmentDto, authorId: string) {
    const attachment = await this.repository.create(dto, authorId);
    this.emitAttachmentEvent('attachment.created', {
      attachmentId: attachment.id,
      entityType: dto.entityType,
      entityId: dto.entityId,
      authorId,
    });
    return attachment;
  }

  private async getFormattedWorkItem(workItemId: string) {
    const basic = await this.requireWorkItem(workItemId);
    const workItem = this.repository.findWorkItemWithDetails
      ? await this.repository.findWorkItemWithDetails(basic.id)
      : await this.prismaService?.workItem?.findUnique({
          where: { id: basic.id },
          include: {
            assignee: { select: USER_MINIMAL_SELECT },
            parentWorkItem: {
              select: { id: true, title: true, identifier: true },
            },
            childWorkItems: {
              select: {
                id: true,
                title: true,
                identifier: true,
                columnId: true,
                completed: true,
                rank: true,
                assigneeId: true,
                assignee: { select: USER_MINIMAL_SELECT },
                dueDate: true,
              },
            },
            project: { select: { id: true } },
          },
        });

    if (!workItem) {
      throw new NotFoundException(`Work item ${workItemId} not found`);
    }

    const records = await this.repository.findByEntity(
      EntityType.work_item,
      basic.id,
    );
    return formatWorkItem({
      ...workItem,
      attachments: formatEntityAttachments(records),
    });
  }

  private async buildAttachmentMutationResponse<
    K extends string,
    V extends Record<string, unknown>,
  >(workItemId: string, message: string, extraKey?: K, extraValue?: V) {
    const formattedWorkItem = await this.getFormattedWorkItem(workItemId);
    return {
      message,
      workItem: formattedWorkItem,
      item: formattedWorkItem,
      ...(extraKey && extraValue ? { [extraKey]: extraValue } : {}),
    };
  }

  /**
   * Retrieves all attachments for a work item.
   */
  async getAttachments(workItemId: string) {
    const workItem = await this.requireWorkItem(workItemId);
    const records = await this.repository.findByEntity(
      EntityType.work_item,
      workItem.id,
    );
    const center = formatEntityAttachments(records);

    return {
      workItemId: workItem.id,
      total: records.length,
      attachments: records,
      center,
      pages: center.pages,
      papers: center.papers,
      files: center.files,
      links: center.links,
    };
  }

  /**
   * Adds an attachment to a work item.
   */
  async addAttachment(
    workItemId: string,
    dto: AddAttachmentDto,
    authorId: string,
  ) {
    const workItem = await this.requireWorkItem(workItemId);
    const attachment = await this.repository.create(
      {
        entityType: EntityType.work_item,
        entityId: workItem.id,
        filename: dto.filename || dto.name || 'attachment',
        url: dto.url,
        storageKey: dto.storageKey,
        size: dto.size || 0,
        mimeType: dto.mimeType || 'application/octet-stream',
        projectId: workItem.projectId,
        metadata: dto.metadata,
      },
      authorId,
    );

    this.emitAttachmentEvent('attachment.created', {
      attachmentId: attachment.id,
      entityType: EntityType.work_item,
      entityId: workItem.id,
      authorId,
    });

    return attachment;
  }

  /**
   * Removes an attachment from a work item.
   */
  async removeAttachment(
    workItemId: string,
    attachmentId: string,
    authorId: string,
  ) {
    await this.requireWorkItem(workItemId);
    return this.deleteAttachment(attachmentId, authorId);
  }

  private async linkEntity(
    workItemId: string,
    entityType: EntityType,
    entityId: string,
    description?: string,
  ): Promise<void> {
    try {
      if (this.repository.upsertEntityLink) {
        await this.repository.upsertEntityLink(
          workItemId,
          entityType,
          entityId,
          description,
        );
      } else if (this.prismaService?.workItemEntityLink) {
        await this.prismaService.workItemEntityLink.upsert({
          where: {
            workItemId_entityType_entityId: {
              workItemId,
              entityType,
              entityId,
            },
          },
          create: { workItemId, entityType, entityId, description },
          update: { description },
        });
      }
    } catch (err) {
      this.logger.warn(
        `Failed to link ${entityType} to work item ${workItemId}: ${(err as Error).message}`,
      );
    }
  }

  private async unlinkEntity(
    workItemId: string,
    entityType: EntityType,
    entityId: string,
  ): Promise<void> {
    try {
      if (this.repository.deleteEntityLink) {
        await this.repository.deleteEntityLink(
          workItemId,
          entityType,
          entityId,
        );
      } else if (this.prismaService?.workItemEntityLink) {
        await this.prismaService.workItemEntityLink.deleteMany({
          where: { workItemId, entityType, entityId },
        });
      }
    } catch (err) {
      this.logger.warn(
        `Failed to unlink ${entityType} from work item ${workItemId}: ${(err as Error).message}`,
      );
    }
  }

  private async detachLinkedEntity(
    workItemId: string,
    targetId: string,
    entityType: 'page' | 'paper',
  ) {
    const workItem = await this.requireWorkItem(workItemId);
    const metaKey = entityType === 'page' ? 'pageId' : 'paperId';
    const prismaEntityType =
      entityType === 'page' ? EntityType.page : EntityType.paper;
    const label = entityType === 'page' ? 'Page' : 'Paper';

    const records = await this.repository.findByEntity(
      EntityType.work_item,
      workItem.id,
    );
    const target = records.find(
      (r) => r.id === targetId || getAttachmentMeta(r)[metaKey] === targetId,
    );
    if (target) {
      await this.repository.delete(target.id);
    }

    const resolvedEntityId = getAttachmentMeta(target)[metaKey] || targetId;
    await this.unlinkEntity(workItem.id, prismaEntityType, resolvedEntityId);

    return this.buildAttachmentMutationResponse(
      workItem.id,
      `${label} detached successfully`,
    );
  }

  async attachPage(workItemId: string, dto: AttachPageDto, authorId: string) {
    const workItem = await this.requireWorkItem(workItemId);
    const title = dto.title?.trim() || 'Untitled Page';
    const pageId = dto.pageId;

    const attachment = await this.repository.create(
      {
        entityType: EntityType.work_item,
        entityId: workItem.id,
        filename: title,
        url: `/pages/${pageId}`,
        mimeType: 'application/x-page',
        size: 0,
        projectId: workItem.projectId,
        metadata: { category: 'page', pageId, title },
      },
      authorId,
    );

    await this.linkEntity(workItem.id, EntityType.page, pageId, title);

    return this.buildAttachmentMutationResponse(
      workItem.id,
      'Page attached successfully',
      'page',
      {
        id: attachment.id,
        pageId,
        title,
        addedAt: attachment.createdAt.toISOString(),
      },
    );
  }

  async detachPage(workItemId: string, pageId: string, _authorId?: string) {
    return this.detachLinkedEntity(workItemId, pageId, 'page');
  }

  async attachPaper(workItemId: string, dto: AttachPaperDto, authorId: string) {
    const workItem = await this.requireWorkItem(workItemId);
    const title = dto.title?.trim() || 'Untitled Paper';
    const paperId = dto.paperId;
    const url = dto.doi ? `https://doi.org/${dto.doi}` : '';

    const attachment = await this.repository.create(
      {
        entityType: EntityType.work_item,
        entityId: workItem.id,
        filename: title,
        url,
        mimeType: 'application/x-paper',
        size: 0,
        projectId: workItem.projectId,
        metadata: {
          category: 'paper',
          paperId,
          title,
          doi: dto.doi || null,
          citationKey: dto.citationKey || null,
        },
      },
      authorId,
    );

    await this.linkEntity(workItem.id, EntityType.paper, paperId, title);

    return this.buildAttachmentMutationResponse(
      workItem.id,
      'Paper attached successfully',
      'paper',
      {
        id: attachment.id,
        paperId,
        title,
        doi: dto.doi,
        citationKey: dto.citationKey,
        addedAt: attachment.createdAt.toISOString(),
      },
    );
  }

  async detachPaper(workItemId: string, paperId: string, _authorId?: string) {
    return this.detachLinkedEntity(workItemId, paperId, 'paper');
  }

  async attachFile(workItemId: string, dto: AttachFileDto, authorId: string) {
    const workItem = await this.requireWorkItem(workItemId);
    const parsedSize =
      typeof dto.size === 'string'
        ? parseInt(dto.size, 10) || 0
        : dto.size || 0;

    const attachment = await this.repository.create(
      {
        entityType: EntityType.work_item,
        entityId: workItem.id,
        filename: dto.name,
        url: dto.url,
        mimeType: dto.type || 'application/octet-stream',
        size: parsedSize,
        projectId: workItem.projectId,
        metadata: { category: 'file', name: dto.name },
      },
      authorId,
    );

    return this.buildAttachmentMutationResponse(
      workItem.id,
      'File attached successfully',
      'file',
      {
        id: attachment.id,
        name: dto.name,
        url: dto.url,
        size: parsedSize,
        type: dto.type,
        uploadedAt: attachment.createdAt.toISOString(),
      },
    );
  }

  async detachFile(workItemId: string, fileId: string, authorId?: string) {
    const workItem = await this.requireWorkItem(workItemId);
    const records = await this.repository.findByEntity(
      EntityType.work_item,
      workItem.id,
    );
    const target = records.find(
      (r) =>
        r.id === fileId ||
        getAttachmentMeta(r).fileId === fileId ||
        Boolean(r.url?.includes(fileId)),
    );

    if (target) {
      await this.deleteAttachment(target.id, authorId);
    } else {
      await this.repository.delete(fileId).catch(() => undefined);
    }

    return this.buildAttachmentMutationResponse(
      workItem.id,
      'File detached successfully',
    );
  }

  async attachLink(workItemId: string, dto: AttachLinkDto, authorId: string) {
    const workItem = await this.requireWorkItem(workItemId);
    const title = dto.title?.trim() || dto.url;

    const attachment = await this.repository.create(
      {
        entityType: EntityType.work_item,
        entityId: workItem.id,
        filename: title,
        url: dto.url,
        mimeType: 'text/uri-list',
        size: 0,
        projectId: workItem.projectId,
        metadata: { category: 'link', title, url: dto.url },
      },
      authorId,
    );

    return this.buildAttachmentMutationResponse(
      workItem.id,
      'Link attached successfully',
      'link',
      {
        title,
        url: dto.url,
        addedAt: attachment.createdAt.toISOString(),
      },
    );
  }

  async detachLink(
    workItemId: string,
    linkIndexOrId: string | number,
    _authorId?: string,
  ) {
    const workItem = await this.requireWorkItem(workItemId);
    const records = await this.repository.findByEntity(
      EntityType.work_item,
      workItem.id,
    );
    const linkRecords = records.filter(
      (r) =>
        getAttachmentMeta(r).category === 'link' ||
        r.mimeType === 'text/uri-list',
    );

    const idx = Number(linkIndexOrId);
    const target =
      linkRecords.find((r) => r.id === String(linkIndexOrId)) ||
      (!Number.isNaN(idx) ? linkRecords[idx] : undefined);

    if (target) {
      await this.repository.delete(target.id);
    }

    return this.buildAttachmentMutationResponse(
      workItem.id,
      'Link detached successfully',
    );
  }

  /**
   * Retrieves list of attachments matching filters.
   */
  async getAttachmentsFiltered(query: QueryAttachmentDto) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 50;
    const skip = (page - 1) * limit;

    return this.repository.findMany(
      {
        entityType: query.entityType,
        entityId: query.entityId,
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

    const metaFileId = getAttachmentMeta(attachment).fileId;
    const urlMatch = attachment.url?.match(/\/api\/files\/([a-zA-Z0-9_-]+)/);
    const fileId = metaFileId || urlMatch?.[1];

    if (fileId && this.storagePort?.deleteFile) {
      try {
        await this.storagePort.deleteFile(fileId);
      } catch (err: unknown) {
        this.logger.warn(
          `Failed to delete storage file ${fileId}: ${(err as Error).message}`,
        );
      }
    } else if (attachment.storageKey && this.r2Service) {
      try {
        await this.r2Service.deleteObject(attachment.storageKey);
      } catch (err: unknown) {
        this.logger.warn(
          `Failed to delete storage object ${attachment.storageKey}: ${(err as Error).message}`,
        );
      }
    }

    await this.repository.delete(id);

    this.emitAttachmentEvent('attachment.deleted', {
      attachmentId: id,
      entityType: attachment.entityType,
      entityId: attachment.entityId,
      authorId,
    });

    return { success: true, id };
  }

  /**
   * Retrieves all work items linked to a specific entity (e.g. page or paper).
   */
  async getWorkItemsByLinkedEntity(entityType: EntityType, entityId: string) {
    const links = this.repository.findLinkedWorkItems
      ? await this.repository.findLinkedWorkItems(entityType, entityId)
      : this.prismaService?.workItemEntityLink
        ? await this.prismaService.workItemEntityLink.findMany({
            where: { entityType, entityId },
            include: {
              workItem: {
                select: {
                  id: true,
                  identifier: true,
                  title: true,
                  columnId: true,
                  state: true,
                  priority: true,
                  projectId: true,
                  createdAt: true,
                  updatedAt: true,
                },
              },
            },
            orderBy: { createdAt: 'desc' },
          })
        : [];

    return links.map((link) => ({
      linkId: link.id,
      entityType: link.entityType,
      entityId: link.entityId,
      description: link.description,
      createdAt: link.createdAt,
      workItem: link.workItem,
    }));
  }
}
