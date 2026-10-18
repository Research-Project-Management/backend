import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  Inject,
  Optional,
} from '@nestjs/common';
import { Prisma, AttachmentType } from '@prisma/client';
import {
  TransactionService,
  TransactionHelpers,
  CATALOG_FACADE,
  ICatalogFacade,
  extractFileIdFromUrl,
} from '@/modules/library/core';
import {
  CreateAttachmentInput,
  ReplaceAttachmentFileInput,
} from '@/modules/library/extraction/types/attachments.types';
import {
  validateAttachmentInvariants,
  inferAttachmentTypeFromFilename,
  calculateFileChecksum,
} from '@/modules/library/extraction/domain/attachments.domain';

import { AttachmentsRepository } from '@/modules/library/extraction/repositories/attachments.repository';

import type {
  UpsertSyncAttachmentCommand,
  DeleteSyncEntityCommand,
  UpsertSyncEntityResult,
} from '@/modules/library/core/types/entity-commands.types';
import { STORAGE_PORT, IStoragePort } from '@/modules/storage/storage.port';
import {
  STORAGE_DRIVER,
  STORAGE_NODE_REPOSITORY,
} from '@/modules/storage/storage.tokens';
import type { IStorageDriver } from '@/modules/storage/core';
import type { IStorageNodeRepository } from '@/modules/storage/drive';
import { PdfThumbnailService } from '@/modules/storage/worker';
import type {
  RenameAttachmentDto,
  BatchRenameAttachmentsDto,
} from '@/modules/library/extraction/dto/attachments.dto';
import {
  UserId,
  ItemId,
  AttachmentId,
  ProjectId,
} from '@/modules/library/core/types/branded.types';
import { AttachmentSyncService } from './attachment-sync.service';
import { AttachmentRenamerService } from './attachment-renamer.service';
import { AttachmentThumbnailService } from './attachment-thumbnail.service';

export type { CreateAttachmentInput, ReplaceAttachmentFileInput };

@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger(AttachmentsService.name);

  constructor(
    private readonly repo: AttachmentsRepository,
    private readonly libraryTx: TransactionService,
    @Optional()
    @Inject(CATALOG_FACADE)
    private readonly catalogGateway?: ICatalogFacade,
    @Optional()
    @Inject(STORAGE_PORT)
    private readonly storagePort?: IStoragePort,
    @Optional()
    @Inject(STORAGE_DRIVER)
    private readonly storageDriver?: IStorageDriver,
    @Optional()
    @Inject(STORAGE_NODE_REPOSITORY)
    private readonly storageNodeRepo?: IStorageNodeRepository,
    @Optional()
    @Inject(PdfThumbnailService)
    private readonly pdfThumbnailService?: PdfThumbnailService,
    @Optional()
    private readonly syncService: AttachmentSyncService = new AttachmentSyncService(),
    @Optional()
    private readonly renamerService: AttachmentRenamerService = new AttachmentRenamerService(
      repo,
      catalogGateway,
    ),
    @Optional()
    private readonly thumbnailService: AttachmentThumbnailService = new AttachmentThumbnailService(
      storageDriver,
      storageNodeRepo,
      storagePort,
      pdfThumbnailService,
    ),
  ) {}

  private async assertItemExists(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<void> {
    if (this.catalogGateway) {
      const exists = await this.catalogGateway.itemExists(
        userId,
        itemId,
        projectId,
      );
      if (!exists) {
        throw new NotFoundException(`Item ${itemId} not found`);
      }
    }
  }

  calculateChecksum(buffer: Buffer): string {
    return calculateFileChecksum(buffer);
  }

  async createAttachment(input: CreateAttachmentInput, projectId?: string) {
    validateAttachmentInvariants({
      url: input.url,
      filename: input.filename,
      size: input.size,
      mimeType: input.mimeType,
      fileHash: input.fileHash,
      fileId: input.fileId,
    });

    const targetItemId = input.itemId;
    if (!targetItemId) {
      throw new BadRequestException('Item ID is required');
    }

    const userId = input.userId || 'system';
    await this.assertItemExists(userId, targetItemId, projectId);

    const resolvedFileId = input.fileId || extractFileIdFromUrl(input.url);

    const effectiveUrl =
      input.url && input.url.trim() !== ''
        ? input.url
        : resolvedFileId
          ? projectId && projectId !== 'user'
            ? `/api/v1/projects/${projectId}/library/files/${resolvedFileId}/content`
            : `/api/v1/library/files/${resolvedFileId}/content`
          : '';

    const sizeBigInt = input.size !== undefined ? BigInt(input.size) : 0n;

    let resolvedLinkMode = input.linkMode;
    if (!resolvedLinkMode) {
      if (
        input.mimeType === 'text/html' ||
        input.attachmentType === 'snapshot'
      ) {
        resolvedLinkMode = 'imported_url';
      } else if (
        !resolvedFileId &&
        effectiveUrl &&
        /^https?:\/\//i.test(effectiveUrl)
      ) {
        resolvedLinkMode = 'linked_url';
      } else {
        resolvedLinkMode = 'imported_file';
      }
    }

    const resolvedAttachmentType: AttachmentType =
      input.attachmentType ??
      (input.isPrimary
        ? AttachmentType.primary_pdf
        : resolvedLinkMode === 'imported_url'
          ? AttachmentType.snapshot
          : input.filename
            ? inferAttachmentTypeFromFilename(input.filename)
            : AttachmentType.primary_pdf);

    return this.libraryTx.executeInTransaction(
      async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
        const attachment = await tx.attachment.create({
          data: {
            itemId: targetItemId,
            linkMode: resolvedLinkMode,
            attachmentType: resolvedAttachmentType,
            filename: input.filename,
            url: effectiveUrl,
            mimeType:
              input.mimeType ??
              (resolvedLinkMode === 'linked_url'
                ? 'text/uri-list'
                : 'application/pdf'),
            size: sizeBigInt,
            fileHash: input.fileHash ?? '',
            fileId: resolvedFileId,
            revisions: {
              create: {
                revisionNumber: 1,
                url: effectiveUrl,
                fileHash: input.fileHash ?? '',
                fileId: resolvedFileId,
                sizeBytes: sizeBigInt,
                comment:
                  resolvedLinkMode === 'linked_url'
                    ? 'Linked URI'
                    : 'Initial file upload',
              },
            },
          },
          include: {
            revisions: {
              orderBy: { revisionNumber: 'desc' },
            },
          },
        });

        if (resolvedFileId) {
          await this.repo.updateLinkedFile(resolvedFileId, targetItemId, tx);
        }

        const eventScope = { userId, projectId: projectId || undefined };

        await helpers.appendChange(eventScope, {
          entityType: 'Attachment',
          entityId: attachment.id,
          action: 'create',
          version: 1,
          data: attachment,
        });

        await helpers.publishOutbox(
          eventScope,
          attachment.id,
          'library.attachment.created',
          attachment,
        );

        if (attachment.mimeType === 'application/pdf') {
          await helpers.publishOutbox(
            eventScope,
            attachment.id,
            'library.attachment.extraction_requested',
            {
              attachmentId: attachment.id,
              itemId: attachment.itemId,
              userId,
              projectId: projectId || undefined,
            },
          );
        }

        return attachment;
      },
    );
  }

  async getItemAttachments(
    userId: UserId | string,
    itemId: ItemId | string,
    projectId?: ProjectId | string,
  ) {
    await this.assertItemExists(userId, itemId, projectId);

    const attachments = await this.repo.findManyByItemId(itemId);

    return { attachments, total: attachments.length };
  }

  async getItemAttachment(
    userId: UserId | string,
    itemId: ItemId | string | undefined,
    attachmentId: AttachmentId | string,
    projectId?: ProjectId | string,
  ) {
    const scopeItemWhere =
      projectId && projectId !== 'user'
        ? { projectId, deletedAt: null }
        : { userId, projectId: null, deletedAt: null };
    const where: Prisma.AttachmentWhereInput = {
      id: attachmentId,
      item: scopeItemWhere,
    };
    if (itemId) {
      where.itemId = itemId;
    }

    const attachment = await this.repo.findFirst(where, {
      revisions: { orderBy: { revisionNumber: 'desc' } },
    });

    if (!attachment) {
      throw new NotFoundException(`Attachment ${attachmentId} not found`);
    }

    return { attachment };
  }

  async deleteAttachment(
    userId: UserId | string,
    attachmentId: AttachmentId | string,
    projectId?: ProjectId | string,
  ) {
    if (!attachmentId) {
      throw new BadRequestException('Attachment ID is required');
    }

    const scopeItemWhere =
      projectId && projectId !== 'user'
        ? { projectId, deletedAt: null }
        : { userId, projectId: null, deletedAt: null };

    const attachment = await this.repo.findFirst(
      {
        id: attachmentId,
        item: scopeItemWhere,
      },
      { item: true },
    );

    if (!attachment) {
      throw new NotFoundException(`Attachment ${attachmentId} not found`);
    }

    const targetFileId =
      attachment.fileId || extractFileIdFromUrl(attachment.url);

    const result = await this.libraryTx.executeInTransaction(
      async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
        const effectiveProjectId =
          projectId || attachment.item?.projectId || undefined;
        const eventScope = { userId, projectId: effectiveProjectId };

        await tx.attachment.delete({
          where: { id: attachment.id },
        });

        await helpers.appendChange(eventScope, {
          entityType: 'Attachment',
          entityId: attachment.id,
          action: 'delete',
          version: 1,
          data: { id: attachment.id },
        });

        await helpers.publishOutbox(
          eventScope,
          attachment.id,
          'library.attachment.deleted',
          { attachmentId: attachment.id, projectId: effectiveProjectId },
        );

        return { success: true };
      },
    );

    if (targetFileId && this.storagePort?.deleteFile) {
      try {
        await this.storagePort.deleteFile(targetFileId);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Failed to delete storage file ${targetFileId} on attachment delete: ${message}`,
        );
      }
    }

    return result;
  }

  async upsertFromSync(
    command: UpsertSyncAttachmentCommand,
    tx: Prisma.TransactionClient,
    helpers: TransactionHelpers,
  ): Promise<UpsertSyncEntityResult> {
    return this.syncService.upsertFromSync(command, tx, helpers);
  }

  async deleteFromSync(
    command: DeleteSyncEntityCommand,
    tx: Prisma.TransactionClient,
    helpers: TransactionHelpers,
  ): Promise<void> {
    return this.syncService.deleteFromSync(command, tx, helpers);
  }

  async reassignToItem(
    sourceItemIds: (ItemId | string)[],
    targetItemId: ItemId | string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    await this.repo.reassignToItem(sourceItemIds, targetItemId, tx);
  }

  async assertAttachmentExists(
    attachmentId: AttachmentId | string,
    userId?: UserId | string,
    tx?: Prisma.TransactionClient,
  ) {
    const attachment = await this.repo.findUnique(
      attachmentId,
      { item: true },
      tx,
    );
    if (!attachment) {
      throw new NotFoundException(`Attachment ${attachmentId} not found`);
    }

    if (userId && attachment.item) {
      const item = attachment.item;
      if (!item.projectId && item.userId && item.userId !== userId) {
        throw new NotFoundException(`Attachment ${attachmentId} not found`);
      }
    }

    return attachment;
  }

  async setPrimaryAttachment(
    userId: UserId | string,
    itemId: ItemId | string,
    attachmentId: AttachmentId | string,
    projectId?: ProjectId | string,
  ) {
    const scopeItemWhere =
      projectId && projectId !== 'user'
        ? { projectId, deletedAt: null }
        : { userId, projectId: null, deletedAt: null };
    const attachment = await this.repo.findFirst({
      id: attachmentId,
      itemId,
      item: scopeItemWhere,
    });
    if (!attachment) {
      throw new NotFoundException(`Attachment ${attachmentId} not found`);
    }

    await this.repo.setPrimaryAttachment(itemId, attachmentId);

    return { success: true };
  }

  async assertAttachmentInScope(
    attachmentId: AttachmentId | string,
    scopeOrUserId?: UserId | ProjectId | string,
    tx?: Prisma.TransactionClient,
  ) {
    const attachment = await this.repo.findUnique(
      attachmentId,
      { item: true },
      tx,
    );
    if (!attachment) {
      throw new NotFoundException(`Attachment ${attachmentId} not found`);
    }

    if (scopeOrUserId && attachment.item) {
      const item = attachment.item;
      if (item.projectId === scopeOrUserId) {
        return attachment;
      }
      if (!item.projectId && item.userId && item.userId !== scopeOrUserId) {
        throw new NotFoundException(`Attachment ${attachmentId} not found`);
      }
    }

    return attachment;
  }

  async getThumbnail(
    userId: string,
    attachmentId: string,
    projectId?: string,
  ): Promise<{ buffer: Buffer; mimeType: string }> {
    const { attachment } = await this.getItemAttachment(
      userId,
      undefined,
      attachmentId,
      projectId,
    );

    if (!attachment) {
      throw new NotFoundException(`Attachment ${attachmentId} not found`);
    }

    return this.thumbnailService.getThumbnail(
      userId,
      attachmentId,
      attachment.fileId,
    );
  }

  async renameAttachment(
    userId: UserId | string,
    attachmentId: AttachmentId | string,
    dto: RenameAttachmentDto,
    projectId?: ProjectId | string,
  ) {
    return this.renamerService.renameAttachment(
      userId,
      attachmentId,
      dto,
      projectId,
    );
  }

  async batchRenameAttachments(
    userId: string,
    dto: BatchRenameAttachmentsDto,
    projectId?: string,
  ): Promise<{
    renamedCount: number;
    results: Array<{
      attachmentId: string;
      itemId: string;
      oldFilename: string;
      newFilename: string;
    }>;
  }> {
    return this.renamerService.batchRenameAttachments(userId, dto, projectId);
  }

  async resolveAttachmentItemId(
    attachmentId: AttachmentId | string,
  ): Promise<ItemId> {
    const attachment = await this.repo.findUnique(attachmentId);
    if (!attachment?.itemId) {
      throw new NotFoundException(`Attachment ${attachmentId} not found`);
    }
    return attachment.itemId as ItemId;
  }

  async resolveItemUrl(
    itemId: ItemId | string,
    userId: UserId | string,
    projectId?: ProjectId | string,
  ): Promise<string> {
    const item = this.catalogGateway
      ? await this.catalogGateway.getItem(userId, itemId, projectId)
      : null;
    if (!item) {
      throw new NotFoundException(`Item ${itemId} not found`);
    }
    const directUrl = typeof item.url === 'string' ? item.url : undefined;
    const fieldsUrl =
      item.fields && typeof item.fields === 'object' && 'url' in item.fields
        ? typeof item.fields.url === 'string'
          ? item.fields.url
          : undefined
        : undefined;
    const itemUrl = directUrl || fieldsUrl;
    if (!itemUrl) {
      throw new BadRequestException(
        'No URL found on this item to capture a snapshot.',
      );
    }
    return itemUrl;
  }

  async reExtractAttachment(
    userId: string,
    attachmentId: string,
    projectId?: string,
  ): Promise<{ status: string; attachmentId: string; message: string }> {
    const attachment = await this.repo.findUnique(attachmentId, {
      item: true,
    });

    const isAuthorized =
      attachment &&
      (projectId && projectId !== 'user'
        ? attachment.item.projectId === projectId
        : attachment.item.userId === userId && !attachment.item.projectId);

    if (!isAuthorized) {
      throw new NotFoundException(`Attachment ${attachmentId} not found`);
    }

    if (
      attachment.mimeType !== 'application/pdf' &&
      !attachment.filename?.toLowerCase().endsWith('.pdf')
    ) {
      throw new BadRequestException(
        `Attachment ${attachmentId} is not a PDF file`,
      );
    }

    const eventScope =
      projectId && projectId !== 'user' ? { projectId, userId } : { userId };

    return this.libraryTx.executeInTransaction(
      async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
        await tx.attachment.update({
          where: { id: attachmentId },
          data: {
            extractionStatus: 'PENDING',
            extractionAttempts: 0,
            extractionLastError: null,
          },
        });

        await helpers.publishOutbox(
          eventScope,
          attachment.id,
          'library.attachment.extraction_requested',
          {
            attachmentId: attachment.id,
            itemId: attachment.itemId,
            userId,
            projectId:
              projectId && projectId !== 'user' ? projectId : undefined,
          },
        );

        return {
          status: 'PENDING',
          attachmentId: attachment.id,
          message: 'Re-extraction and OCR job queued successfully',
        };
      },
    );
  }
}
