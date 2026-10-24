import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  Inject,
  Optional,
} from '@nestjs/common';
import { Prisma, AttachmentType } from '@prisma/client';
import { RedisCacheService } from '@/core';
import {
  TransactionHelpers,
  CATALOG_FACADE,
  ICatalogFacade,
  LIBRARY_REDIS_KEYS,
  normalizeProjectScopeId,
  extractFileIdFromUrl,
} from '@/modules/library/core';
import { TransactionService } from '@/modules/library/sync';
import { CreateAttachmentInput } from '@/modules/library/extraction/types/attachments.types';
import {
  validateAttachmentInvariants,
  inferAttachmentTypeFromFilename,
} from '@/modules/library/extraction/domain/attachments.domain';

import { AttachmentsRepository } from '@/modules/library/extraction/repositories/attachments.repository';

import { STORAGE_PORT, IStoragePort } from '@/modules/storage/storage.port';
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
import { AttachmentRenamerService } from './attachment-renamer.service';
import { AttachmentThumbnailService } from './attachment-thumbnail.service';

export type { CreateAttachmentInput };

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
    private readonly renamerService?: AttachmentRenamerService,
    @Optional()
    private readonly thumbnailService?: AttachmentThumbnailService,
    @Optional()
    private readonly cache?: RedisCacheService,
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

    let resolvedFileId = input.fileId || extractFileIdFromUrl(input.url);

    // Content-Addressable Storage (CAS) Deduplication:
    // If incoming upload has a valid fileHash, reuse existing storage blob if available within the same tenant scope
    let storageKey = input.storageKey;
    if (input.fileHash && input.fileHash.trim().length >= 32) {
      const effectiveProjectId = normalizeProjectScopeId(
        projectId || input.projectId,
      );
      const existingWithHash = await this.repo.findFirst({
        fileHash: input.fileHash.trim(),
        storageKey: { not: null },
        item: effectiveProjectId
          ? { projectId: effectiveProjectId, deletedAt: null }
          : { userId, projectId: null, deletedAt: null },
      });
      if (existingWithHash?.storageKey) {
        storageKey = existingWithHash.storageKey;
        if (!resolvedFileId && existingWithHash.fileId) {
          resolvedFileId = existingWithHash.fileId;
        }
      }
    }

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
        const createData: Prisma.AttachmentCreateInput = {
          item: { connect: { id: targetItemId } },
          linkMode: resolvedLinkMode,
          attachmentType: resolvedAttachmentType,
          filename: input.filename,
          url: effectiveUrl,
          storageKey: storageKey ?? undefined,
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
        };
        const includeOpts = {
          revisions: {
            orderBy: { revisionNumber: 'desc' as const },
          },
        };
        const attachment = await this.repo.create(
          createData,
          includeOpts,
          tx,
        );

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
    ).then(async (attachment) => {
      await this.invalidateAttachmentItemCache(
        targetItemId,
        userId,
        projectId,
      );
      return attachment;
    });
  }

  private async invalidateAttachmentItemCache(
    itemId: string,
    userId: string,
    projectId?: string,
  ): Promise<void> {
    if (!this.cache || !itemId) return;
    try {
      const validProjectId = normalizeProjectScopeId(projectId);
      const scopeId = validProjectId || userId;
      const countsScopeKey = validProjectId
        ? `proj:${validProjectId}`
        : `user:${userId}`;
      await Promise.all([
        this.cache.del(LIBRARY_REDIS_KEYS.item(itemId)),
        this.cache.del(LIBRARY_REDIS_KEYS.itemDetails(itemId)),
        ...(scopeId
          ? [
              this.cache.delPattern(LIBRARY_REDIS_KEYS.itemsPattern(scopeId)),
              this.cache.del(LIBRARY_REDIS_KEYS.counts(countsScopeKey)),
            ]
          : []),
      ]);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Failed to invalidate item cache after attachment mutation (${itemId}): ${message}`,
      );
    }
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
      { item: true, revisions: true },
    );

    if (!attachment) {
      throw new NotFoundException(`Attachment ${attachmentId} not found`);
    }

    const fileIdsToDelete = new Set<string>();
    const mainFileId =
      attachment.fileId || extractFileIdFromUrl(attachment.url);
    if (mainFileId) {
      fileIdsToDelete.add(mainFileId);
    }
    if (Array.isArray(attachment.revisions)) {
      for (const rev of attachment.revisions) {
        const revFileId = rev.fileId || extractFileIdFromUrl(rev.url);
        if (revFileId) {
          fileIdsToDelete.add(revFileId);
        }
      }
    }

    const effectiveProjectId =
      projectId || attachment.item?.projectId || undefined;

    const result = await this.libraryTx.executeInTransaction(
      async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
        const eventScope = { userId, projectId: effectiveProjectId };

        await this.repo.delete(attachment.id, tx);

        await helpers.appendChange(eventScope, {
          entityType: 'Attachment',
          entityId: attachment.id,
          action: 'delete',
          version: 1,
          data: { id: attachment.id },
        });

        await helpers.recordTombstone?.(eventScope, {
          entityType: 'Attachment',
          entityId: attachment.id,
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

    if (attachment.itemId) {
      await this.invalidateAttachmentItemCache(
        attachment.itemId,
        userId,
        effectiveProjectId,
      );
    }

    if (fileIdsToDelete.size > 0 && this.storagePort?.deleteFile) {
      for (const fid of fileIdsToDelete) {
        try {
          const remainingRefs = await this.repo.countFileIdReferences?.(
            fid,
            attachment.id,
          );
          if (typeof remainingRefs === 'number' && remainingRefs > 0) {
            continue;
          }
          await this.storagePort.deleteFile(fid);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            `Failed to delete storage file ${fid} on attachment delete: ${message}`,
          );
        }
      }
    }

    return result;
  }

  async reassignToItem(
    sourceItemIds: (ItemId | string)[],
    targetItemId: ItemId | string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const orphanedFileIds = await this.repo.reassignToItem(
      sourceItemIds,
      targetItemId,
      tx,
    );
    if (
      Array.isArray(orphanedFileIds) &&
      orphanedFileIds.length > 0 &&
      this.storagePort?.deleteFile
    ) {
      for (const fid of orphanedFileIds) {
        try {
          await this.storagePort.deleteFile(fid);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            `Failed to delete duplicate attachment file ${fid} on item merge: ${message}`,
          );
        }
      }
    }
  }

  async assertAttachmentExists(
    attachmentId: AttachmentId | string,
    userId?: UserId | string,
    tx?: Prisma.TransactionClient,
    projectId?: ProjectId | string,
  ) {
    const attachment = await this.repo.findUnique(
      attachmentId,
      { item: true },
      tx,
    );
    if (!attachment) {
      throw new NotFoundException(`Attachment ${attachmentId} not found`);
    }

    if (attachment.item) {
      const item = attachment.item;
      if (projectId && projectId !== 'user') {
        if (item.projectId !== projectId) {
          throw new NotFoundException(`Attachment ${attachmentId} not found`);
        }
      } else if (item.projectId) {
        throw new NotFoundException(`Attachment ${attachmentId} not found`);
      } else if (userId && item.userId && item.userId !== userId) {
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

    const effectiveProjectId =
      projectId && projectId !== 'user' ? projectId : undefined;

    await this.libraryTx.executeInTransaction(
      async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
        await this.repo.setPrimaryAttachment(itemId, attachmentId, tx);
        const eventScope = { userId, projectId: effectiveProjectId };
        await helpers.appendChange(eventScope, {
          entityType: 'Attachment',
          entityId: attachmentId,
          action: 'update',
          version: 1,
          data: {
            id: attachmentId,
            itemId,
            attachmentType: AttachmentType.primary_pdf,
          },
        });
      },
    );

    if (this.cache) {
      const validProjectId = normalizeProjectScopeId(projectId);
      const scopeId = validProjectId || userId;
      await Promise.all([
        this.cache.del(LIBRARY_REDIS_KEYS.item(itemId)),
        this.cache.del(LIBRARY_REDIS_KEYS.itemDetails(itemId)),
        this.cache.del(`library:item:${itemId}:attachments`),
        this.cache.delPattern(LIBRARY_REDIS_KEYS.itemPattern(itemId)),
        this.cache.delPattern(LIBRARY_REDIS_KEYS.itemsPattern(scopeId)),
        ...(validProjectId
          ? [
              this.cache.delPattern(
                LIBRARY_REDIS_KEYS.itemsPattern(`proj:${validProjectId}`),
              ),
              this.cache.delPattern(LIBRARY_REDIS_KEYS.itemsPattern(userId)),
            ]
          : []),
      ]);
    }

    return { success: true };
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

    if (!this.thumbnailService) {
      throw new NotFoundException('Thumbnail service unavailable');
    }

    return this.thumbnailService.getThumbnail(
      userId,
      attachmentId,
      attachment.fileId,
      projectId,
    );
  }

  async renameAttachment(
    userId: UserId | string,
    attachmentId: AttachmentId | string,
    dto: RenameAttachmentDto,
    projectId?: ProjectId | string,
  ) {
    const renamerService =
      this.renamerService ??
      new AttachmentRenamerService(this.repo, this.catalogGateway, this.cache);
    return renamerService.renameAttachment(
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
    const renamerService =
      this.renamerService ??
      new AttachmentRenamerService(this.repo, this.catalogGateway, this.cache);
    return renamerService.batchRenameAttachments(userId, dto, projectId);
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
        const updateData: Prisma.AttachmentUpdateInput = {
          extractionStatus: 'PENDING',
          extractionAttempts: 0,
          extractionLastError: null,
        };
        await this.repo.update(attachmentId, updateData, tx);

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
