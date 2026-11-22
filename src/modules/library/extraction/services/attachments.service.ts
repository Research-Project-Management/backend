import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
  Inject,
  Optional,
} from '@nestjs/common';
import { Prisma, AttachmentType } from '@prisma/client';
import { RedisCacheService } from '@/core';
import {
  TransactionHelpers,
  CATALOG_FACADE,
  ICatalogFacade,
  IItemCacheInvalidator,
  ITEM_CACHE_INVALIDATOR,
  normalizeProjectSpaceId,
  extractFileIdFromUrl,
  executeStandardLibraryCacheInvalidation,
  UNIT_OF_WORK,
  IUnitOfWork,
  LIBRARY_EVENT_TYPES,
  UserId,
  ItemId,
  AttachmentId,
  ProjectId,
} from '@/modules/library/core';
import { CreateAttachmentInput } from '@/modules/library/core/types/extraction.types';
import {
  validateAttachmentInvariants,
  inferAttachmentTypeFromFilename,
  isValidFileHash,
} from '@/modules/library/extraction/domain/attachments.domain';
import { AttachmentsRepository } from '@/modules/library/extraction/repositories/attachments.repository';
import { ExtractionRepository } from '@/modules/library/extraction/repositories/extraction.repository';
import { FILES_PORT, IFilesPort } from '@/modules/files';
import type {
  RenameAttachmentDto,
  BatchRenameAttachmentsDto,
} from '@/modules/library/extraction/dto/attachments.dto';
import { AttachmentRenamerService } from './attachment-renamer.service';

export type { CreateAttachmentInput };

@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger(AttachmentsService.name);

  constructor(
    private readonly repo: AttachmentsRepository,
    @Optional() @Inject(UNIT_OF_WORK) private readonly libraryTx: IUnitOfWork,
    @Optional()
    @Inject(CATALOG_FACADE)
    private readonly catalogGateway?: ICatalogFacade,
    @Optional()
    @Inject(FILES_PORT)
    private readonly filesPort?: IFilesPort,
    @Optional() private readonly renamerService?: AttachmentRenamerService,
    @Optional() private readonly cache?: RedisCacheService,
    @Optional()
    @Inject(ITEM_CACHE_INVALIDATOR)
    private readonly cacheCoordinator?: IItemCacheInvalidator,
    @Optional() private readonly extractionRepo?: ExtractionRepository,
  ) {}

  public async assertItemExists(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<void> {
    if (!this.catalogGateway) {
      throw new InternalServerErrorException(
        'Catalog gateway is unavailable for item authorization',
      );
    }
    const exists = await this.catalogGateway.itemExists(
      userId,
      itemId,
      projectId,
    );
    if (!exists) throw new NotFoundException(`Item ${itemId} not found`);
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
    const effectiveProjectId = normalizeProjectSpaceId(
      projectId || input.projectId,
    );
    await this.assertItemExists(userId, targetItemId, effectiveProjectId);

    let resolvedFileId = input.fileId || extractFileIdFromUrl(input.url);
    const targetSpaceId = effectiveProjectId || userId;

    // Content-Addressable Storage (CAS) Deduplication:
    // If incoming upload has a valid fileHash without an existing fileId, reuse storage blob within the same space and acquire CAS ref + quota
    let storageKey = input.storageKey;
    let deduplicated = false;
    if (!resolvedFileId && input.fileHash && isValidFileHash(input.fileHash)) {
      const existingWithHash = await this.repo.findFirst({
        fileHash: input.fileHash.trim(),
        storageKey: { not: null },
        deletedAt: null,
        item: { spaceId: targetSpaceId, deletedAt: null },
      });
      if (existingWithHash?.storageKey) {
        storageKey = existingWithHash.storageKey;
        deduplicated = true;
        if (existingWithHash.fileId) {
          resolvedFileId = existingWithHash.fileId;
          if (this.filesPort?.acquireBlob) {
            const acquired = await this.filesPort.acquireBlob(
              existingWithHash.fileId,
            );
            if (acquired && this.filesPort.reserveQuota) {
              await this.filesPort
                .reserveQuota(targetSpaceId, acquired.sizeBytes)
                .catch(() => {});
            }
          }
        }
      }
    }

    const effectiveUrl =
      input.url && input.url.trim() !== ''
        ? input.url
        : resolvedFileId
          ? effectiveProjectId
            ? `/api/v1/spaces/${effectiveProjectId}/library/files/${resolvedFileId}/content`
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

    let postCommitRegistered = false;
    return this.libraryTx
      .executeInTransaction(
        async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
          const resolvedMimeType =
            input.mimeType ??
            (resolvedLinkMode === 'linked_url'
              ? 'text/uri-list'
              : 'application/pdf');
          const isExtractablePdf =
            resolvedMimeType === 'application/pdf' ||
            input.filename?.toLowerCase().endsWith('.pdf');
          const validCreatorId =
            userId &&
            userId !== 'system' &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
              userId,
            )
              ? userId
              : undefined;
          const createData: Prisma.AttachmentCreateInput = {
            item: { connect: { id: targetItemId } },
            ...(validCreatorId ? { createdById: validCreatorId } : {}),
            linkMode: resolvedLinkMode,
            attachmentType: resolvedAttachmentType,
            filename: input.filename,
            url: effectiveUrl,
            storageKey: storageKey ?? undefined,
            mimeType: resolvedMimeType,
            ...(!isExtractablePdf
              ? {
                  extractionStatus: 'READY',
                  extractionCompletedAt: new Date(),
                }
              : {}),
            size: sizeBigInt,
            fileHash: input.fileHash ?? '',
            fileId: resolvedFileId,
            ...(input.metadata && Object.keys(input.metadata).length > 0
              ? { metadata: input.metadata as Prisma.InputJsonValue }
              : {}),
            revisions: {
              create: {
                ...(validCreatorId ? { createdById: validCreatorId } : {}),
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

          const eventScope = { userId, projectId: effectiveProjectId };

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
            LIBRARY_EVENT_TYPES.ATTACHMENT_CREATED,
            serializedAttachment,
          );

          if (isExtractablePdf && resolvedLinkMode !== 'linked_url') {
            await helpers.publishOutbox(
              eventScope,
              attachment.id,
              LIBRARY_EVENT_TYPES.ATTACHMENT_EXTRACTION_REQUESTED,
              {
                attachmentId: attachment.id,
                itemId: attachment.itemId,
                userId,
                projectId: effectiveProjectId,
              },
            );
          }

          if (helpers?.onAfterCommit) {
            postCommitRegistered = true;
            helpers.onAfterCommit(async () => {
              await this.invalidateAttachmentItemCache(
                targetItemId,
                userId,
                effectiveProjectId,
              );
            });
          }

          return serializedAttachment;
        },
      )
      .then(async (attachment) => {
        if (!postCommitRegistered) {
          await this.invalidateAttachmentItemCache(
            targetItemId,
            userId,
            effectiveProjectId,
          );
        }
        return attachment;
      });
  }

  private async invalidateAttachmentItemCache(
    itemId: string,
    userId: string,
    projectId?: string,
  ): Promise<void> {
    if (!itemId) return;
    await executeStandardLibraryCacheInvalidation(
      this.cacheCoordinator ?? this.catalogGateway,
      this.cache,
      { userId, projectId, itemIds: [itemId] },
      (message) =>
        this.logger.warn(
          `Failed to invalidate item cache after attachment mutation (${itemId}): ${message}`,
        ),
    );
  }

  async getItemAttachments(
    userId: UserId | string,
    itemId: ItemId | string,
    projectId?: ProjectId | string,
  ) {
    await this.assertItemExists(userId, itemId, projectId);
    const rawAttachments = await this.repo.findManyByItemId(itemId);
    const attachments = (rawAttachments || [])
      .filter((att) => !att.deletedAt)
      .map((att) => ({
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
    const validProjectId = normalizeProjectSpaceId(projectId);
    const scopeItemWhere = {
      spaceId: validProjectId || userId,
      deletedAt: null,
    };
    const where: Prisma.AttachmentWhereInput = {
      id: attachmentId,
      deletedAt: null,
      item: scopeItemWhere,
      ...(itemId ? { itemId } : {}),
    };
    const raw = await this.repo.findFirst(where, {
      revisions: { orderBy: { revisionNumber: 'desc' } },
    });
    const rawItem = (
      raw as { item?: { deletedAt?: Date | null } | null } | null
    )?.item;
    if (!raw || raw.deletedAt || rawItem?.deletedAt) {
      throw new NotFoundException(`Attachment ${attachmentId} not found`);
    }
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
    if (!attachmentId)
      throw new BadRequestException('Attachment ID is required');
    const validProjectId = normalizeProjectSpaceId(projectId);
    const scopeItemWhere = {
      spaceId: validProjectId || userId,
      deletedAt: null,
    };
    const attachment = await this.repo.findFirst(
      { id: attachmentId, deletedAt: null, item: scopeItemWhere },
      { item: true, revisions: true },
    );
    if (!attachment)
      throw new NotFoundException(`Attachment ${attachmentId} not found`);
    const fileIdsToDelete = new Set<string>();
    const mainFileId =
      attachment.fileId || extractFileIdFromUrl(attachment.url);
    if (mainFileId) fileIdsToDelete.add(mainFileId);
    if (Array.isArray(attachment.revisions)) {
      for (const rev of attachment.revisions) {
        const revFileId = rev.fileId || extractFileIdFromUrl(rev.url);
        if (revFileId) fileIdsToDelete.add(revFileId);
      }
    }
    const itemRec = attachment.item as
      | {
          spaceId?: string;
          projectId?: string | null;
          createdById?: string;
        }
      | null
      | undefined;
    const itemProjectId =
      itemRec?.projectId ??
      (itemRec?.spaceId && itemRec.spaceId !== itemRec.createdById
        ? itemRec.spaceId
        : undefined);
    const effectiveProjectId =
      validProjectId || normalizeProjectSpaceId(itemProjectId) || undefined;
    const targetSpaceId =
      itemRec?.spaceId ??
      effectiveProjectId ??
      (typeof userId === 'string' ? userId : undefined);
    let postCommitRegistered = false;
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
          LIBRARY_EVENT_TYPES.ATTACHMENT_DELETED,
          {
            attachmentId: attachment.id,
            itemId: attachment.itemId,
            projectId: effectiveProjectId,
          },
        );
        if (attachment.itemId && helpers?.onAfterCommit) {
          postCommitRegistered = true;
          helpers.onAfterCommit(() =>
            this.invalidateAttachmentItemCache(
              attachment.itemId,
              userId,
              effectiveProjectId,
            ),
          );
        }
        return { success: true };
      },
    );

    if (attachment.itemId && !postCommitRegistered) {
      await this.invalidateAttachmentItemCache(
        attachment.itemId,
        userId,
        effectiveProjectId,
      );
    }

    if (fileIdsToDelete.size > 0 && this.filesPort?.deleteFile) {
      const candidateFileIds = Array.from(fileIdsToDelete);
      const deleteTarget = targetSpaceId
        ? { spaceId: targetSpaceId }
        : undefined;
      await Promise.all(
        candidateFileIds.map(async (fid) => {
          try {
            await this.filesPort!.deleteFile(fid, deleteTarget);
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.warn(
              `Failed to delete storage file ${fid} on attachment delete: ${message}`,
            );
          }
        }),
      );
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

  async cleanupOrphanedFiles(
    orphanedFileIds?: string[],
    target?: { spaceId?: string },
  ): Promise<void> {
    if (
      !Array.isArray(orphanedFileIds) ||
      orphanedFileIds.length === 0 ||
      !this.filesPort?.deleteFile
    ) {
      return;
    }
    const candidateFileIds = Array.from(new Set(orphanedFileIds));
    const deleteTarget = target?.spaceId
      ? { spaceId: target.spaceId }
      : undefined;
    await Promise.all(
      candidateFileIds.map(async (fid) => {
        try {
          await this.filesPort!.deleteFile(fid, deleteTarget);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            `Failed to delete duplicate attachment file ${fid} on item merge: ${message}`,
          );
        }
      }),
    );
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
    if (
      !attachment ||
      attachment.deletedAt ||
      (attachment.item && attachment.item.deletedAt)
    ) {
      throw new NotFoundException(`Attachment ${attachmentId} not found`);
    }

    if (attachment.item) {
      const item = attachment.item as {
        spaceId?: string;
        createdById?: string;
        projectId?: string | null;
        userId?: string;
      };
      const validProjectId = normalizeProjectSpaceId(projectId);
      if (item.spaceId) {
        const expectedSpaceId = validProjectId || userId;
        if (expectedSpaceId && item.spaceId !== expectedSpaceId) {
          throw new NotFoundException(`Attachment ${attachmentId} not found`);
        }
      } else if (validProjectId) {
        if (item.projectId !== validProjectId) {
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
    const effectiveProjectId = normalizeProjectSpaceId(projectId);
    const scopeItemWhere = {
      spaceId: effectiveProjectId || userId,
      deletedAt: null,
    };
    const attachment = await this.repo.findFirst({
      id: attachmentId,
      itemId,
      deletedAt: null,
      item: scopeItemWhere,
    });
    if (
      !attachment ||
      attachment.deletedAt ||
      (attachment.item && attachment.item.deletedAt)
    ) {
      throw new NotFoundException(`Attachment ${attachmentId} not found`);
    }

    let postCommitRegistered = false;
    await this.libraryTx.executeInTransaction(
      async (tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
        await this.repo.setPrimaryAttachment(itemId, attachmentId, tx);
        const eventScope = { userId, projectId: effectiveProjectId };
        const payload = {
          id: attachmentId,
          itemId,
          attachmentType: AttachmentType.primary_pdf,
        };
        await helpers.appendChange(eventScope, {
          entityType: 'Attachment',
          entityId: attachmentId,
          action: 'update',
          version: 1,
          data: payload,
        });
        await helpers.publishOutbox?.(
          eventScope,
          attachmentId,
          LIBRARY_EVENT_TYPES.ATTACHMENT_UPDATED,
          payload,
        );
        if (helpers?.onAfterCommit) {
          postCommitRegistered = true;
          helpers.onAfterCommit(() =>
            this.invalidateAttachmentItemCache(
              itemId,
              userId,
              effectiveProjectId,
            ),
          );
        }
      },
    );

    if (!postCommitRegistered) {
      await this.invalidateAttachmentItemCache(
        itemId,
        userId,
        effectiveProjectId,
      );
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
    if (!attachment)
      throw new NotFoundException(`Attachment ${attachmentId} not found`);
    if (!attachment.fileId || !this.filesPort) {
      throw new NotFoundException(
        `No PDF binary available for attachment ${attachmentId}`,
      );
    }
    const thumbBuffer = await this.filesPort.ensurePdfThumbnail({
      fileId: attachment.fileId,
      spaceId: projectId || userId,
      userId,
    });
    if (!thumbBuffer) {
      throw new NotFoundException(
        `Failed to generate thumbnail for attachment ${attachmentId}`,
      );
    }
    return { buffer: thumbBuffer, mimeType: 'image/webp' };
  }

  private getRenamerService(): AttachmentRenamerService {
    return (
      this.renamerService ??
      new AttachmentRenamerService(
        this.repo,
        this.catalogGateway,
        this.cache,
        this.libraryTx,
        this.cacheCoordinator,
      )
    );
  }

  async renameAttachment(
    userId: UserId | string,
    attachmentId: AttachmentId | string,
    dto: RenameAttachmentDto,
    projectId?: ProjectId | string,
  ) {
    return this.getRenamerService().renameAttachment(
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
    return this.getRenamerService().batchRenameAttachments(
      userId,
      dto,
      projectId,
    );
  }

  async resolveItemUrl(
    itemId: ItemId | string,
    userId: UserId | string,
    projectId?: ProjectId | string,
  ): Promise<string> {
    const item = this.catalogGateway
      ? await this.catalogGateway.getItem(userId, itemId, projectId)
      : null;
    if (!item) throw new NotFoundException(`Item ${itemId} not found`);
    const directUrl = typeof item.url === 'string' ? item.url : undefined;
    const fieldsUrl =
      item.fields &&
      typeof item.fields === 'object' &&
      'url' in item.fields &&
      typeof item.fields.url === 'string'
        ? item.fields.url
        : undefined;
    const itemUrl = directUrl || fieldsUrl;
    if (!itemUrl)
      throw new BadRequestException(
        'No URL found on this item to capture a snapshot.',
      );
    return itemUrl;
  }

  async getExtractionStatusBreakdown(scope?: {
    userId?: string;
    projectId?: string | null;
  }): Promise<Record<string, number>> {
    return this.extractionRepo?.getExtractionStatusBreakdown
      ? this.extractionRepo.getExtractionStatusBreakdown(scope)
      : {};
  }

  async reExtractAttachment(
    userId: string,
    attachmentId: string,
    projectId?: string,
  ): Promise<{ status: string; attachmentId: string; message: string }> {
    const effectiveProjectId = normalizeProjectSpaceId(projectId);
    const attachment = await this.repo.findUnique(attachmentId, { item: true });
    const itemRec = attachment?.item as
      | {
          spaceId?: string;
          createdById?: string;
          projectId?: string | null;
          userId?: string;
          deletedAt?: Date | null;
        }
      | null
      | undefined;
    const isAuthorized =
      attachment &&
      !attachment.deletedAt &&
      itemRec &&
      !itemRec.deletedAt &&
      (itemRec.spaceId
        ? itemRec.spaceId === (effectiveProjectId || userId)
        : effectiveProjectId
          ? itemRec.projectId === effectiveProjectId
          : itemRec.userId === userId && !itemRec.projectId);
    if (!isAuthorized)
      throw new NotFoundException(`Attachment ${attachmentId} not found`);
    if (
      attachment.mimeType !== 'application/pdf' &&
      !attachment.filename?.toLowerCase().endsWith('.pdf')
    ) {
      throw new BadRequestException(
        `Attachment ${attachmentId} is not a PDF file`,
      );
    }
    const eventScope = effectiveProjectId
      ? { projectId: effectiveProjectId, userId }
      : { userId };

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
          LIBRARY_EVENT_TYPES.ATTACHMENT_EXTRACTION_REQUESTED,
          {
            attachmentId: attachment.id,
            itemId: attachment.itemId,
            userId,
            projectId: effectiveProjectId,
          },
        );
        return {
          status: 'PENDING',
          attachmentId: attachment.id,
          message: 'Re-extraction job queued successfully',
        };
      },
    );
  }
}
