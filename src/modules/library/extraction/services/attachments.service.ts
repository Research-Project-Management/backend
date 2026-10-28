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
import { ItemCacheCoordinator } from '@/modules/library/catalog';
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
    private readonly cache?: RedisCacheService,
    @Optional()
    private readonly cacheCoordinator?: ItemCacheCoordinator,
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
    const effectiveProjectId = normalizeProjectScopeId(
      projectId || input.projectId,
    );
    await this.assertItemExists(userId, targetItemId, effectiveProjectId);

    let resolvedFileId = input.fileId || extractFileIdFromUrl(input.url);

    if (resolvedFileId && this.storagePort?.assertFileAccess) {
      await this.storagePort.assertFileAccess(
        resolvedFileId,
        userId !== 'system' ? userId : undefined,
        effectiveProjectId,
      );
    }

    // Content-Addressable Storage (CAS) Deduplication:
    // If incoming upload has a valid fileHash, reuse existing storage blob if available within the same user/project scope
    let storageKey = input.storageKey;
    let deduplicated = false;
    if (input.fileHash && input.fileHash.trim().length >= 32) {
      const existingWithHash = await this.repo.findFirst({
        fileHash: input.fileHash.trim(),
        storageKey: { not: null },
        item: effectiveProjectId
          ? { projectId: effectiveProjectId, deletedAt: null }
          : { userId, projectId: null, deletedAt: null },
      });
      if (existingWithHash?.storageKey) {
        storageKey = existingWithHash.storageKey;
        deduplicated = true;
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

    let sizeBigInt = 0n;
    if (input.size !== undefined && input.size !== null) {
      if (typeof input.size === 'bigint') {
        if (input.size < 0n) {
          throw new BadRequestException('Attachment size must be non-negative');
        }
        sizeBigInt = input.size;
      } else {
        const numericSize = Number(input.size);
        if (!Number.isFinite(numericSize) || numericSize < 0) {
          throw new BadRequestException(
            'Attachment size must be a valid non-negative integer',
          );
        }
        sizeBigInt = BigInt(Math.max(0, Math.trunc(numericSize)));
      }
    }

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
          ...(input.metadata && Object.keys(input.metadata).length > 0
            ? { metadata: input.metadata as Prisma.InputJsonValue }
            : {}),
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

        if (resolvedFileId && !deduplicated) {
          await this.repo.updateLinkedFile(resolvedFileId, targetItemId, tx);
        }

        const eventScope = { userId, projectId: projectId || undefined };

        const serializedAttachment = {
          ...attachment,
          size: Number(attachment.size),
          fileSize: Number(attachment.size),
          revisions: attachment.revisions?.map((rev) => ({
            ...rev,
            sizeBytes: Number(rev.sizeBytes),
          })),
        };

        await helpers.appendChange(eventScope, {
          entityType: 'Attachment',
          entityId: attachment.id,
          action: 'create',
          version: 1,
          data: serializedAttachment,
        });

        await helpers.publishOutbox(
          eventScope,
          attachment.id,
          'library.attachment.created',
          serializedAttachment,
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

        return serializedAttachment;
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
    if (!itemId) return;
    if (this.cacheCoordinator) {
      await this.cacheCoordinator.invalidateForWrite({
        userId,
        projectId,
        itemIds: [itemId],
      });
      return;
    }
    if (!this.cache) return;
    try {
      const validProjectId = normalizeProjectScopeId(projectId);
      const scopeId = validProjectId || userId;
      const countsScopeKey = validProjectId
        ? `proj:${validProjectId}`
        : `user:${userId}`;
      await Promise.all([
        this.cache.del(LIBRARY_REDIS_KEYS.item(itemId)),
        this.cache.del(LIBRARY_REDIS_KEYS.itemDetails(itemId)),
        this.cache.delPattern(LIBRARY_REDIS_KEYS.itemPattern(itemId)),
        ...(scopeId
          ? [
              this.cache.delPattern(LIBRARY_REDIS_KEYS.itemsPattern(scopeId)),
              this.cache.delPattern(LIBRARY_REDIS_KEYS.countsPattern(scopeId)),
              this.cache.delPattern(
                LIBRARY_REDIS_KEYS.countsPattern(countsScopeKey),
              ),
              this.cache.delPattern(
                LIBRARY_REDIS_KEYS.searchFacetsPattern(scopeId),
              ),
              this.cache.delPattern(
                LIBRARY_REDIS_KEYS.searchItemsPattern(scopeId),
              ),
            ]
          : []),
        ...(validProjectId
          ? [
              this.cache.delPattern(
                LIBRARY_REDIS_KEYS.itemsPattern(`proj:${validProjectId}`),
              ),
              this.cache.delPattern(LIBRARY_REDIS_KEYS.itemsPattern(userId)),
              this.cache.delPattern(LIBRARY_REDIS_KEYS.countsPattern(userId)),
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
    const rawAttachments = await this.repo.findManyByItemId(itemId);
    const attachments = rawAttachments.map((att) => ({
      ...att,
      size: Number(att.size),
      fileSize: Number(att.size),
      revisions: att.revisions?.map((rev) => ({
        ...rev,
        sizeBytes: Number(rev.sizeBytes),
      })),
    }));
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
      ...(itemId ? { itemId } : {}),
    };
    const raw = await this.repo.findFirst(where, {
      revisions: { orderBy: { revisionNumber: 'desc' } },
    });
    if (!raw) throw new NotFoundException(`Attachment ${attachmentId} not found`);
    const attachment = {
      ...raw,
      size: Number(raw.size),
      fileSize: Number(raw.size),
      revisions: raw.revisions?.map((rev) => ({
        ...rev,
        sizeBytes: Number(rev.sizeBytes),
      })),
    };
    return { attachment };
  }

  async deleteAttachment(
    userId: UserId | string,
    attachmentId: AttachmentId | string,
    projectId?: ProjectId | string,
  ) {
    if (!attachmentId) throw new BadRequestException('Attachment ID is required');
    const scopeItemWhere =
      projectId && projectId !== 'user'
        ? { projectId, deletedAt: null }
        : { userId, projectId: null, deletedAt: null };
    const attachment = await this.repo.findFirst(
      { id: attachmentId, item: scopeItemWhere },
      { item: true, revisions: true },
    );
    if (!attachment) throw new NotFoundException(`Attachment ${attachmentId} not found`);
    const fileIdsToDelete = new Set<string>();
    const mainFileId = attachment.fileId || extractFileIdFromUrl(attachment.url);
    if (mainFileId) fileIdsToDelete.add(mainFileId);
    if (Array.isArray(attachment.revisions)) {
      for (const rev of attachment.revisions) {
        const revFileId = rev.fileId || extractFileIdFromUrl(rev.url);
        if (revFileId) fileIdsToDelete.add(revFileId);
      }
    }
    const effectiveProjectId = projectId || attachment.item?.projectId || undefined;
    const result = await this.libraryTx.executeInTransaction(
      async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
        const eventScope = { userId, projectId: effectiveProjectId };
        await this.repo.delete(attachment.id, tx);
        await helpers.appendChange(eventScope, {
          entityType: 'Attachment',
          entityId: attachment.id,
          action: 'delete',
          version: 1,
          data: { id: attachment.id, itemId: attachment.itemId },
        });
        await helpers.recordTombstone?.(eventScope, {
          entityType: 'Attachment',
          entityId: attachment.id,
        });
        await helpers.publishOutbox(
          eventScope,
          attachment.id,
          'library.attachment.deleted',
          { attachmentId: attachment.id, itemId: attachment.itemId, projectId: effectiveProjectId },
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
  ): Promise<string[]> {
    const orphanedFileIds = await this.repo.reassignToItem(
      sourceItemIds,
      targetItemId,
      tx,
    );
    if (tx) {
      // Defer physical S3 deletion until after the transaction commits
      return Array.isArray(orphanedFileIds) ? orphanedFileIds : [];
    }
    await this.cleanupOrphanedFiles(orphanedFileIds);
    return Array.isArray(orphanedFileIds) ? orphanedFileIds : [];
  }

  async cleanupOrphanedFiles(orphanedFileIds?: string[]): Promise<void> {
    if (
      !Array.isArray(orphanedFileIds) ||
      orphanedFileIds.length === 0 ||
      !this.storagePort?.deleteFile
    ) {
      return;
    }
    for (const fid of orphanedFileIds) {
      try {
        if (this.repo.countFileIdReferences) {
          const remainingRefs = await this.repo.countFileIdReferences(fid);
          if (typeof remainingRefs === 'number' && remainingRefs > 0) {
            continue;
          }
        }
        await this.storagePort.deleteFile(fid);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Failed to delete duplicate attachment file ${fid} on item merge: ${message}`,
        );
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
    const { attachment } = await this.getItemAttachment(userId, undefined, attachmentId, projectId);
    if (!attachment) throw new NotFoundException(`Attachment ${attachmentId} not found`);
    if (!attachment.fileId || !this.storagePort) {
      throw new NotFoundException(`No PDF binary available for attachment ${attachmentId}`);
    }
    const thumbBuffer = await this.storagePort.ensurePdfThumbnail({
      fileId: attachment.fileId,
      userId,
      projectId,
    });
    if (!thumbBuffer) {
      throw new NotFoundException(`Failed to generate thumbnail for attachment ${attachmentId}`);
    }
    return { buffer: thumbBuffer, mimeType: 'image/webp' };
  }

  async renameAttachment(
    userId: UserId | string,
    attachmentId: AttachmentId | string,
    dto: RenameAttachmentDto,
    projectId?: ProjectId | string,
  ) {
    const renamer =
      this.renamerService ??
      new AttachmentRenamerService(
        this.repo,
        this.catalogGateway,
        this.cache,
        this.libraryTx,
        this.cacheCoordinator,
      );
    return renamer.renameAttachment(userId, attachmentId, dto, projectId);
  }

  async batchRenameAttachments(
    userId: string,
    dto: BatchRenameAttachmentsDto,
    projectId?: string,
  ): Promise<{
    renamedCount: number;
    results: Array<{ attachmentId: string; itemId: string; oldFilename: string; newFilename: string }>;
  }> {
    const renamer =
      this.renamerService ??
      new AttachmentRenamerService(
        this.repo,
        this.catalogGateway,
        this.cache,
        this.libraryTx,
        this.cacheCoordinator,
      );
    return renamer.batchRenameAttachments(userId, dto, projectId);
  }

  async resolveItemUrl(
    itemId: ItemId | string,
    userId: UserId | string,
    projectId?: ProjectId | string,
  ): Promise<string> {
    const item = this.catalogGateway ? await this.catalogGateway.getItem(userId, itemId, projectId) : null;
    if (!item) throw new NotFoundException(`Item ${itemId} not found`);
    const directUrl = typeof item.url === 'string' ? item.url : undefined;
    const fieldsUrl =
      item.fields && typeof item.fields === 'object' && 'url' in item.fields && typeof item.fields.url === 'string'
        ? item.fields.url
        : undefined;
    const itemUrl = directUrl || fieldsUrl;
    if (!itemUrl) throw new BadRequestException('No URL found on this item to capture a snapshot.');
    return itemUrl;
  }

  async reExtractAttachment(
    userId: string,
    attachmentId: string,
    projectId?: string,
  ): Promise<{ status: string; attachmentId: string; message: string }> {
    const attachment = await this.repo.findUnique(attachmentId, { item: true });
    const isAuthorized =
      attachment &&
      (projectId && projectId !== 'user'
        ? attachment.item.projectId === projectId
        : attachment.item.userId === userId && !attachment.item.projectId);
    if (!isAuthorized) throw new NotFoundException(`Attachment ${attachmentId} not found`);
    if (
      attachment.mimeType !== 'application/pdf' &&
      !attachment.filename?.toLowerCase().endsWith('.pdf')
    ) {
      throw new BadRequestException(`Attachment ${attachmentId} is not a PDF file`);
    }
    const eventScope = projectId && projectId !== 'user' ? { projectId, userId } : { userId };

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
            projectId: projectId && projectId !== 'user' ? projectId : undefined,
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
