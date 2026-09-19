import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  Optional,
  Inject,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { FastifyRequest } from 'fastify';
import { AttachmentRepository } from './attachment.repository';
import { R2Service } from '@/modules/storage/infrastructure/drivers/r2.service';
import { STORAGE_PORT, IStoragePort } from '@/modules/storage/storage.port';
import { PrismaService } from '@/core/database/prisma.service';
import {
  CreateAttachmentDto as BaseAttachmentDto,
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
import { isUuid } from '@/core/utils/uuid.util';
import { formatWorkItem } from '../core/utils/work-item.util';

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
    if (isUuid(workItemId) || !this.prismaService.workItem?.findFirst) {
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
      } catch (err: any) {
        this.logger.warn(
          `storagePort.getPresignedUploadUrl failed, falling back to r2Service: ${err?.message}`,
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
      throw new BadRequestException(
        'No file payload found in multipart request',
      );
    }

    const rawEntityType = fields.entityType || 'work_item';
    const entityId =
      fields.entityId || fastifyReq.params?.workItemId || fastifyReq.params?.id;
    if (!entityId) {
      throw new BadRequestException(
        'entityId is required in multipart form data or URL parameter',
      );
    }

    const entityType = rawEntityType as EntityType;
    let resolvedEntityId = entityId;
    let resolvedProjectId = fields.projectId;

    if (entityType === EntityType.work_item) {
      const workItem = await this.findWorkItem(entityId);
      if (workItem) {
        resolvedEntityId = workItem.id;
        if (!resolvedProjectId && workItem.projectId) {
          resolvedProjectId = workItem.projectId;
        }
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

    this.eventEmitter?.emit('attachment.created', {
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

    this.eventEmitter?.emit('attachment.created', {
      attachmentId: attachment.id,
      entityType: dto.entityType,
      entityId: dto.entityId,
      authorId,
    });

    return attachment;
  }

  private formatAttachments(records: any[]) {
    const pages: any[] = [];
    const papers: any[] = [];
    const files: any[] = [];
    const links: any[] = [];

    for (const r of records) {
      const meta = (r.metadata as Record<string, any>) || {};
      const category =
        meta.category ||
        (r.mimeType === 'application/x-page'
          ? 'page'
          : r.mimeType === 'application/x-paper'
            ? 'paper'
            : r.mimeType === 'text/uri-list'
              ? 'link'
              : 'file');

      if (category === 'page') {
        pages.push({
          id: r.id,
          pageId: meta.pageId || r.id,
          title: meta.title || r.filename,
          slug: meta.slug || null,
          addedAt: r.createdAt
            ? new Date(r.createdAt).toISOString()
            : new Date().toISOString(),
        });
      } else if (category === 'paper') {
        papers.push({
          id: r.id,
          paperId: meta.paperId || r.id,
          title: meta.title || r.filename,
          doi: meta.doi || null,
          citationKey: meta.citationKey || null,
          addedAt: r.createdAt
            ? new Date(r.createdAt).toISOString()
            : new Date().toISOString(),
        });
      } else if (category === 'link') {
        links.push({
          id: r.id,
          title: meta.title || r.filename,
          url: r.url,
          addedAt: r.createdAt
            ? new Date(r.createdAt).toISOString()
            : new Date().toISOString(),
        });
      } else {
        files.push({
          id: r.id,
          name: r.filename,
          url: r.url,
          size: r.size ? `${Math.round(r.size / 1024)} KB` : undefined,
          type: r.mimeType,
          createdAt: r.createdAt
            ? new Date(r.createdAt).toISOString()
            : new Date().toISOString(),
          uploadedAt: r.createdAt
            ? new Date(r.createdAt).toISOString()
            : new Date().toISOString(),
        });
      }
    }

    return { pages, papers, files, links };
  }

  private async getFormattedWorkItem(workItemId: string) {
    const basic = await this.findWorkItem(workItemId);
    if (!basic) {
      throw new NotFoundException(`Work item ${workItemId} not found`);
    }
    const workItem = await this.prismaService.workItem.findUnique({
      where: { id: basic.id },
      include: {
        assignee: {
          select: { id: true, name: true, email: true, avatar: true },
        },
        cycle: { select: { id: true, name: true } },
        parentWorkItem: { select: { id: true, title: true, identifier: true } },
        childWorkItems: {
          select: {
            id: true,
            title: true,
            identifier: true,
            columnId: true,
            completed: true,
            rank: true,
            assigneeId: true,
            assignee: {
              select: { id: true, name: true, email: true, avatar: true },
            },
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
    const center = this.formatAttachments(records);
    return formatWorkItem({
      ...workItem,
      attachments: center,
    });
  }

  /**
   * Retrieves all attachments for a work item.
   */
  async getAttachments(workItemId: string) {
    const workItem = await this.findWorkItem(workItemId);
    if (!workItem) {
      throw new NotFoundException(`Work item ${workItemId} not found`);
    }

    const records = await this.repository.findByEntity(
      EntityType.work_item,
      workItem.id,
    );
    const center = this.formatAttachments(records);

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
    createAttachmentDto: BaseAttachmentDto,
    authorId: string,
  ) {
    const workItem = await this.findWorkItem(workItemId);
    if (!workItem) {
      throw new NotFoundException(`Work item ${workItemId} not found`);
    }

    const attachment = await this.repository.create(
      {
        entityType: EntityType.work_item,
        entityId: workItem.id,
        filename:
          createAttachmentDto.filename ||
          createAttachmentDto.name ||
          'attachment',
        url: createAttachmentDto.url,
        storageKey: createAttachmentDto.storageKey,
        size: createAttachmentDto.size || 0,
        mimeType: createAttachmentDto.mimeType || 'application/octet-stream',
        projectId: workItem.projectId,
        metadata: createAttachmentDto.metadata,
      },
      authorId,
    );

    this.eventEmitter?.emit('attachment.created', {
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
    const workItem = await this.findWorkItem(workItemId);
    if (!workItem) {
      throw new NotFoundException(`Work item ${workItemId} not found`);
    }

    return this.deleteAttachment(attachmentId, authorId);
  }

  async attachPage(workItemId: string, dto: AttachPageDto, authorId: string) {
    const workItem = await this.findWorkItem(workItemId);
    if (!workItem) {
      throw new NotFoundException(`Work item ${workItemId} not found`);
    }

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
        metadata: {
          category: 'page',
          pageId,
          title,
        },
      },
      authorId,
    );

    if (this.prismaService.workItemEntityLink) {
      await this.prismaService.workItemEntityLink
        .upsert({
          where: {
            workItemId_entityType_entityId: {
              workItemId: workItem.id,
              entityType: EntityType.page,
              entityId: pageId,
            },
          },
          create: {
            workItemId: workItem.id,
            entityType: EntityType.page,
            entityId: pageId,
            description: title,
          },
          update: {
            description: title,
          },
        })
        .catch(() => null);
    }

    const formattedWorkItem = await this.getFormattedWorkItem(workItem.id);
    return {
      message: 'Page attached successfully',
      workItem: formattedWorkItem,
      item: formattedWorkItem,
      page: {
        id: attachment.id,
        pageId,
        title,
        addedAt: attachment.createdAt.toISOString(),
      },
    };
  }

  async detachPage(workItemId: string, pageId: string, _authorId?: string) {
    const workItem = await this.findWorkItem(workItemId);
    if (!workItem) {
      throw new NotFoundException(`Work item ${workItemId} not found`);
    }

    const records = await this.repository.findByEntity(
      EntityType.work_item,
      workItem.id,
    );
    const target = records.find(
      (r) => r.id === pageId || (r.metadata as any)?.pageId === pageId,
    );
    if (target) {
      await this.repository.delete(target.id);
    }

    if (this.prismaService.workItemEntityLink) {
      const resolvedEntityId = (target?.metadata as any)?.pageId || pageId;
      await this.prismaService.workItemEntityLink
        .deleteMany({
          where: {
            workItemId: workItem.id,
            entityType: EntityType.page,
            entityId: resolvedEntityId,
          },
        })
        .catch(() => null);
    }

    const formattedWorkItem = await this.getFormattedWorkItem(workItem.id);
    return {
      message: 'Page detached successfully',
      workItem: formattedWorkItem,
      item: formattedWorkItem,
    };
  }

  async attachPaper(workItemId: string, dto: AttachPaperDto, authorId: string) {
    const workItem = await this.findWorkItem(workItemId);
    if (!workItem) {
      throw new NotFoundException(`Work item ${workItemId} not found`);
    }

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

    if (this.prismaService.workItemEntityLink) {
      await this.prismaService.workItemEntityLink
        .upsert({
          where: {
            workItemId_entityType_entityId: {
              workItemId: workItem.id,
              entityType: EntityType.paper,
              entityId: paperId,
            },
          },
          create: {
            workItemId: workItem.id,
            entityType: EntityType.paper,
            entityId: paperId,
            description: title,
          },
          update: {
            description: title,
          },
        })
        .catch(() => null);
    }

    const formattedWorkItem = await this.getFormattedWorkItem(workItem.id);
    return {
      message: 'Paper attached successfully',
      workItem: formattedWorkItem,
      item: formattedWorkItem,
      paper: {
        id: attachment.id,
        paperId,
        title,
        doi: dto.doi,
        citationKey: dto.citationKey,
        addedAt: attachment.createdAt.toISOString(),
      },
    };
  }

  async detachPaper(workItemId: string, paperId: string, _authorId?: string) {
    const workItem = await this.findWorkItem(workItemId);
    if (!workItem) {
      throw new NotFoundException(`Work item ${workItemId} not found`);
    }

    const records = await this.repository.findByEntity(
      EntityType.work_item,
      workItem.id,
    );
    const target = records.find(
      (r) => r.id === paperId || (r.metadata as any)?.paperId === paperId,
    );
    if (target) {
      await this.repository.delete(target.id);
    }

    if (this.prismaService.workItemEntityLink) {
      const resolvedEntityId = (target?.metadata as any)?.paperId || paperId;
      await this.prismaService.workItemEntityLink
        .deleteMany({
          where: {
            workItemId: workItem.id,
            entityType: EntityType.paper,
            entityId: resolvedEntityId,
          },
        })
        .catch(() => null);
    }

    const formattedWorkItem = await this.getFormattedWorkItem(workItem.id);
    return {
      message: 'Paper detached successfully',
      workItem: formattedWorkItem,
      item: formattedWorkItem,
    };
  }

  async attachFile(workItemId: string, dto: AttachFileDto, authorId: string) {
    const workItem = await this.findWorkItem(workItemId);
    if (!workItem) {
      throw new NotFoundException(`Work item ${workItemId} not found`);
    }

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
        metadata: {
          category: 'file',
          name: dto.name,
        },
      },
      authorId,
    );

    const formattedWorkItem = await this.getFormattedWorkItem(workItem.id);
    return {
      message: 'File attached successfully',
      workItem: formattedWorkItem,
      item: formattedWorkItem,
      file: {
        id: attachment.id,
        name: dto.name,
        url: dto.url,
        size: parsedSize,
        type: dto.type,
        uploadedAt: attachment.createdAt.toISOString(),
      },
    };
  }

  async detachFile(workItemId: string, fileId: string, authorId?: string) {
    const workItem = await this.findWorkItem(workItemId);
    if (!workItem) {
      throw new NotFoundException(`Work item ${workItemId} not found`);
    }

    const records = await this.repository.findByEntity(
      EntityType.work_item,
      workItem.id,
    );
    const target = records.find(
      (r) =>
        r.id === fileId ||
        (r.metadata as any)?.fileId === fileId ||
        (r.url && r.url.includes(fileId)),
    );

    if (target) {
      await this.deleteAttachment(target.id, authorId);
    } else {
      try {
        await this.repository.delete(fileId);
      } catch {
        // file may already have been removed
      }
    }

    const formattedWorkItem = await this.getFormattedWorkItem(workItem.id);
    return {
      message: 'File detached successfully',
      workItem: formattedWorkItem,
      item: formattedWorkItem,
    };
  }

  async attachLink(workItemId: string, dto: AttachLinkDto, authorId: string) {
    const workItem = await this.findWorkItem(workItemId);
    if (!workItem) {
      throw new NotFoundException(`Work item ${workItemId} not found`);
    }

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
        metadata: {
          category: 'link',
          title,
          url: dto.url,
        },
      },
      authorId,
    );

    const formattedWorkItem = await this.getFormattedWorkItem(workItem.id);
    return {
      message: 'Link attached successfully',
      workItem: formattedWorkItem,
      item: formattedWorkItem,
      link: {
        title,
        url: dto.url,
        addedAt: attachment.createdAt.toISOString(),
      },
    };
  }

  async detachLink(
    workItemId: string,
    linkIndexOrId: string | number,
    _authorId?: string,
  ) {
    const workItem = await this.findWorkItem(workItemId);
    if (!workItem) {
      throw new NotFoundException(`Work item ${workItemId} not found`);
    }

    const records = await this.repository.findByEntity(
      EntityType.work_item,
      workItem.id,
    );
    const linkRecords = records.filter(
      (r) =>
        (r.metadata as any)?.category === 'link' ||
        r.mimeType === 'text/uri-list',
    );

    let target = linkRecords.find((r) => r.id === String(linkIndexOrId));
    if (!target) {
      const idx = Number(linkIndexOrId);
      if (!Number.isNaN(idx) && linkRecords[idx]) {
        target = linkRecords[idx];
      }
    }

    if (target) {
      await this.repository.delete(target.id);
    }

    const formattedWorkItem = await this.getFormattedWorkItem(workItem.id);
    return {
      message: 'Link detached successfully',
      workItem: formattedWorkItem,
      item: formattedWorkItem,
    };
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

    const metaFileId = (attachment.metadata as any)?.fileId;
    const urlMatch = attachment.url?.match(/\/api\/files\/([a-zA-Z0-9_-]+)/);
    const fileId = metaFileId || (urlMatch ? urlMatch[1] : undefined);
    if (fileId && this.storagePort?.deleteFile) {
      try {
        await this.storagePort.deleteFile(fileId);
      } catch (err: any) {
        this.logger.warn(
          `Failed to delete storage file ${fileId}: ${err?.message}`,
        );
      }
    } else if (attachment.storageKey && this.r2Service) {
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

  /**
   * Retrieves all work items linked to a specific entity (e.g. page or paper).
   */
  async getWorkItemsByLinkedEntity(entityType: EntityType, entityId: string) {
    if (!this.prismaService.workItemEntityLink) {
      return [];
    }

    const links = await this.prismaService.workItemEntityLink.findMany({
      where: {
        entityType,
        entityId,
      },
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
    });

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
