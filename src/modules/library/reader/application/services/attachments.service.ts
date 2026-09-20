import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { Prisma, AttachmentType } from '@prisma/client';
import { createHash } from 'crypto';
import {
  TransactionService,
  TransactionHelpers,
} from '../../../shared-kernel/outbox/transaction.service';
import {
  CreateAttachmentInput,
  ReplaceAttachmentFileInput,
} from '../../domain/types/attachments.types';
import { validateAttachmentInvariants } from '../utils/attachments.utils';

import { AttachmentsRepository } from '../../infrastructure/repositories/attachments.repository';

import type {
  UpsertSyncAttachmentCommand,
  DeleteSyncEntityCommand,
  UpsertSyncEntityResult,
} from '../../../shared-kernel/core/types/entity-commands.types';
import { Inject, Optional } from '@nestjs/common';
import {
  BIBLIOGRAPHY_FACADE,
  IBibliographyFacade,
} from '../../../bibliography/bibliography.facade';
import { IStoragePort, STORAGE_PORT } from '@/modules/storage/storage.port';
import {
  STORAGE_DRIVER,
  STORAGE_NODE_REPOSITORY,
} from '@/modules/storage/storage.tokens';
import { IStorageDriver } from '@/modules/storage/domain/ports/storage-driver.port';
import { IStorageNodeRepository } from '@/modules/storage/domain/ports/storage-node.repository.port';
import { PdfThumbnailService } from '@/modules/storage/application/services/pdf-thumbnail.service';

import { calculateFileChecksum } from '../utils/attachments.utils';
import {
  formatAttachmentFilename,
  resolveFileExtension,
  sanitizeFilenameStem,
  DEFAULT_RENAME_PATTERN,
} from '../utils/renamer.util';
import type {
  RenameAttachmentDto,
  BatchRenameAttachmentsDto,
} from '../dtos/attachments.dto';
import {
  UserId,
  ItemId,
  AttachmentId,
  ProjectId,
} from '../../../shared-kernel/core/types/branded.types';

export { CreateAttachmentInput, ReplaceAttachmentFileInput };

@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger(AttachmentsService.name);

  constructor(
    private readonly repo: AttachmentsRepository,
    private readonly libraryTx: TransactionService,
    @Optional()
    @Inject(BIBLIOGRAPHY_FACADE)
    private readonly bibliographyFacade?: IBibliographyFacade,
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
    private readonly pdfThumbnailService?: PdfThumbnailService,
  ) {}

  private async assertItemExists(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<void> {
    if (this.bibliographyFacade) {
      const exists = await this.bibliographyFacade.itemExists(
        userId,
        itemId,
        projectId,
      );
      if (!exists) {
        throw new NotFoundException(`Item ${itemId} not found`);
      }
    }
  }

  /**
   * Computes SHA-256 hex digest of a file buffer.
   */
  calculateChecksum(buffer: Buffer): string {
    return calculateFileChecksum(buffer);
  }

  /**
   * Creates a new attachment with an initial Revision (revision 1).
   */
  async createAttachment(input: CreateAttachmentInput, projectId?: string) {
    validateAttachmentInvariants({
      url: input.url,
      filename: input.filename,
      size: input.size,
      mimeType: input.mimeType,
      fileHash: input.fileHash,
    });

    const targetItemId = input.itemId;
    if (!targetItemId) {
      throw new BadRequestException('Item ID is required');
    }

    const userId = input.userId || 'system';
    await this.assertItemExists(userId, targetItemId, projectId);

    const resolvedFileId =
      input.fileId ||
      input.url?.match(
        /\/api\/(?:v1\/(?:projects\/[^/]+\/)?library\/)?files\/([a-zA-Z0-9_-]+)/,
      )?.[1] ||
      null;

    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const attachment = await tx.attachment.create({
        data: {
          itemId: targetItemId,
          filename: input.filename,
          url: input.url,
          mimeType: input.mimeType ?? 'application/pdf',
          size: input.size ?? 0,
          fileHash: input.fileHash ?? '',
          fileId: resolvedFileId,
          revisions: {
            create: {
              revisionNumber: 1,
              url: input.url,
              fileHash: input.fileHash ?? '',
              sizeBytes: input.size ?? 0,
              comment: 'Initial file upload',
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
    });
  }

  /**
   * Replaces an attachment's current file by creating an immutable sequential revision.
   */
  async addRevision(
    userId: string,
    attachmentId: string,
    input: ReplaceAttachmentFileInput,
    projectId?: string,
  ) {
    validateAttachmentInvariants({
      url: input.url,
      size: input.sizeBytes,
      fileHash: input.fileHash,
    });

    const attachment = await this.repo.findUnique(attachmentId, {
      item: true,
      revisions: { orderBy: { revisionNumber: 'desc' }, take: 1 },
    });

    const isAuthorized =
      attachment &&
      (projectId && projectId !== 'user'
        ? attachment.item.projectId === projectId
        : attachment.item.userId === userId);

    if (!isAuthorized) {
      throw new NotFoundException(`Attachment ${attachmentId} not found`);
    }

    const nextRevisionNumber =
      (attachment.revisions[0]?.revisionNumber ?? 0) + 1;

    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const updatedAttachment = await tx.attachment.update({
        where: { id: attachmentId },
        data: {
          size: input.sizeBytes,
          fileHash: input.fileHash,
          url: input.url,
        },
      });

      await tx.attachmentRevision.create({
        data: {
          attachmentId,
          revisionNumber: nextRevisionNumber,
          fileHash: input.fileHash || '',
          sizeBytes: input.sizeBytes,
          url: input.url,
          comment: input.comment || 'Revision upload',
        },
      });

      const effectiveProjectId =
        projectId || attachment.item?.projectId || undefined;

      await helpers.appendChange(
        { userId, projectId: effectiveProjectId },
        {
          entityType: 'Attachment',
          entityId: attachmentId,
          action: 'update',
          version: nextRevisionNumber,
          data: updatedAttachment,
        },
      );

      return updatedAttachment;
    });
  }

  /**
   * Retrieves revision history for an attachment.
   */
  async getRevisions(
    userId: UserId | string,
    attachmentId: AttachmentId | string,
    projectId?: ProjectId | string,
  ) {
    const scopeItemWhere =
      projectId && projectId !== 'user'
        ? { projectId, deletedAt: null }
        : { userId, deletedAt: null };
    const attachment = await this.repo.findFirst({
      id: attachmentId,
      item: scopeItemWhere,
    });

    if (!attachment) {
      throw new NotFoundException(`Attachment ${attachmentId} not found`);
    }

    return this.repo.findRevisions(attachment.id);
  }

  /**
   * Retrieves all attachments for an item.
   */
  async getItemAttachments(
    userId: UserId | string,
    itemId: ItemId | string,
    projectId?: ProjectId | string,
  ) {
    await this.assertItemExists(userId, itemId, projectId);

    const attachments = await this.repo.findManyByItemId(itemId);

    return { attachments, total: attachments.length };
  }

  /**
   * Retrieves a specific attachment for an item.
   */
  async getItemAttachment(
    userId: UserId | string,
    itemId: ItemId | string | undefined,
    attachmentId: AttachmentId | string,
    projectId?: ProjectId | string,
  ) {
    const scopeItemWhere =
      projectId && projectId !== 'user'
        ? { projectId, deletedAt: null }
        : { userId, deletedAt: null };
    const where: any = {
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

  /**
   * Deletes an attachment and records a tombstone.
   */
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
        : { userId, deletedAt: null };

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
      attachment.fileId ||
      attachment.url?.match(
        /\/api\/(?:v1\/(?:projects\/[^/]+\/)?library\/)?files\/([a-zA-Z0-9_-]+)/,
      )?.[1];

    const result = await this.libraryTx.executeInTransaction(
      async (tx, helpers) => {
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
      } catch (err: any) {
        this.logger.warn(
          `Failed to delete storage file ${targetFileId} on attachment delete: ${err?.message}`,
        );
      }
    }

    return result;
  }

  /**
   * Sync protocol adapter: transactional upsert for a Attachment from an external sync batch.
   */
  async upsertFromSync(
    command: UpsertSyncAttachmentCommand,
    tx: Prisma.TransactionClient,
    helpers: TransactionHelpers,
  ): Promise<UpsertSyncEntityResult> {
    const projectId = command.projectId;
    const userId = command.userId;
    const actorId = userId || projectId || 'system';

    if (command.existingId) {
      const existing = await tx.attachment.findUnique({
        where: { id: command.existingId },
        include: { item: true },
      });

      if (!existing) {
        throw new NotFoundException(
          `Attachment ${command.existingId} not found`,
        );
      }

      const item = existing.item as any;
      if (projectId && item?.projectId && item.projectId !== projectId) {
        throw new ForbiddenException(
          `Attachment ${command.existingId} does not belong to project ${projectId}`,
        );
      } else if (
        !projectId &&
        userId &&
        item?.userId &&
        !item?.projectId &&
        item.userId !== userId
      ) {
        throw new ForbiddenException(
          `Attachment ${command.existingId} does not belong to user ${userId}`,
        );
      }

      const revisionCount = await tx.attachmentRevision.count({
        where: { attachmentId: command.existingId },
      });
      const nextRevisionNumber = revisionCount + 1;

      const updated = await tx.attachment.update({
        where: { id: command.existingId },
        data: {
          filename: command.filename,
          url: command.url,
          mimeType: command.mimeType,
          fileHash: command.fileHash,
          size: command.size !== undefined ? command.size : undefined,
        },
      });

      await tx.attachmentRevision.create({
        data: {
          attachmentId: updated.id,
          revisionNumber: nextRevisionNumber,
          fileHash: command.fileHash || '',
          sizeBytes: command.size || 0,
          url: command.url,
          comment: 'Sync update',
        },
      });

      const effectiveProjectId =
        projectId || (existing.item as any)?.projectId || undefined;
      const syncScope = { userId: actorId, projectId: effectiveProjectId };

      await helpers.appendChange(syncScope, {
        entityType: 'Attachment',
        entityId: updated.id,
        action: 'update',
        version: nextRevisionNumber,
      });

      return { id: updated.id, isNew: false, version: nextRevisionNumber };
    } else {
      const parentItemId = command.itemId;
      if (!parentItemId) {
        throw new NotFoundException(
          `Parent item ID required for attachment ${command.filename}`,
        );
      }

      const item = await tx.item.findUnique({
        where: { id: parentItemId },
      });

      if (!item) {
        throw new NotFoundException(`Item ${parentItemId} not found`);
      }

      const itemAny = item as any;
      if (projectId && itemAny.projectId && itemAny.projectId !== projectId) {
        throw new ForbiddenException(
          `Item ${parentItemId} does not belong to project ${projectId}`,
        );
      } else if (
        !projectId &&
        userId &&
        itemAny.userId &&
        !itemAny.projectId &&
        itemAny.userId !== userId
      ) {
        throw new ForbiddenException(
          `Item ${parentItemId} does not belong to user ${userId}`,
        );
      }

      const created = await tx.attachment.create({
        data: {
          itemId: parentItemId,
          filename: command.filename,
          url: command.url,
          mimeType: command.mimeType,
          fileHash: command.fileHash,
          attachmentType: command.attachmentType
            ? (command.attachmentType as AttachmentType)
            : AttachmentType.primary_pdf,
          size: command.size || 0,
        },
      });

      await tx.attachmentRevision.create({
        data: {
          attachmentId: created.id,
          revisionNumber: 1,
          fileHash: command.fileHash || '',
          sizeBytes: command.size || 0,
          url: command.url,
          comment: 'Initial sync',
        },
      });

      const effectiveProjectId = projectId || itemAny.projectId || undefined;
      const syncScope = { userId: actorId, projectId: effectiveProjectId };

      await helpers.appendChange(syncScope, {
        entityType: 'Attachment',
        entityId: created.id,
        action: 'create',
        version: 1,
      });

      await helpers.publishOutbox(
        syncScope,
        created.id,
        'library.attachment.created',
        { attachmentId: created.id, projectId: effectiveProjectId },
      );

      if (
        command.mimeType === 'application/pdf' ||
        command.filename?.toLowerCase().endsWith('.pdf')
      ) {
        await helpers.publishOutbox(
          syncScope,
          created.id,
          'library.attachment.extraction_requested',
          {
            attachmentId: created.id,
            itemId: created.itemId,
            userId: actorId,
            projectId: effectiveProjectId,
          },
        );
      }

      return { id: created.id, isNew: true, version: 1 };
    }
  }

  /**
   * Sync protocol adapter: transactional deletion for a Attachment from an external sync batch.
   */
  async deleteFromSync(
    command: DeleteSyncEntityCommand,
    tx: Prisma.TransactionClient,
    helpers: TransactionHelpers,
  ): Promise<void> {
    const projectId = command.projectId;
    const userId = command.userId;
    const actorId = userId || projectId || 'system';

    const itemWhere: Prisma.ItemWhereInput = {};
    if (projectId) {
      itemWhere.projectId = projectId;
    } else if (userId) {
      itemWhere.userId = userId;
    }

    const existing = await tx.attachment.findFirst({
      where: {
        id: command.entityId,
        ...(Object.keys(itemWhere).length > 0 ? { item: itemWhere } : {}),
      },
      include: { item: true },
    });
    if (!existing) return;

    const effectiveProjectId =
      projectId || existing.item?.projectId || undefined;
    const syncScope = { userId: actorId, projectId: effectiveProjectId };

    await tx.attachment.delete({ where: { id: command.entityId } });
    await helpers.appendChange(syncScope, {
      entityType: 'Attachment',
      entityId: command.entityId,
      action: 'delete',
      version: 1,
    });
    await helpers.recordTombstone(syncScope, {
      entityType: 'Attachment',
      entityId: command.entityId,
      deletedById: userId || undefined,
    });
  }

  /**
   * Domain merge helper: reassigns all attachments from source duplicate items to target item.
   */
  async reassignToItem(
    sourceItemIds: (ItemId | string)[],
    targetItemId: ItemId | string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await this.repo.reassignToItem(sourceItemIds, targetItemId, tx);
  }

  /**
   * Domain boundary helper: asserts that an attachment exists.
   */
  async assertAttachmentExists(
    attachmentId: AttachmentId | string,
    userId?: UserId | string,
    tx?: Prisma.TransactionClient,
  ): Promise<any> {
    const attachment = await this.repo.findUnique(
      attachmentId,
      { item: true },
      tx,
    );
    if (!attachment) {
      throw new NotFoundException(`Attachment ${attachmentId} not found`);
    }

    if (userId) {
      const item = attachment.item;
      if (item.projectId) {
        if (item.userId !== userId) {
          const isMember = await this.repo.checkProjectMember(
            item.projectId,
            userId,
            tx,
          );
          if (!isMember) {
            throw new NotFoundException(`Attachment ${attachmentId} not found`);
          }
        }
      } else if (item.userId && item.userId !== userId) {
        throw new NotFoundException(`Attachment ${attachmentId} not found`);
      }
    }

    return attachment;
  }

  /**
   * Sets an attachment as the primary attachment for an item.
   */
  async setPrimaryAttachment(
    userId: UserId | string,
    itemId: ItemId | string,
    attachmentId: AttachmentId | string,
    projectId?: ProjectId | string,
  ) {
    const scopeItemWhere =
      projectId && projectId !== 'user'
        ? { projectId, deletedAt: null }
        : { userId, deletedAt: null };
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
  ): Promise<any> {
    const attachment = await this.repo.findUnique(attachmentId, undefined, tx);
    if (!attachment) {
      throw new NotFoundException(`Attachment ${attachmentId} not found`);
    }
    return attachment;
  }

  /**
   * Retrieves or on-the-fly generates a WebP thumbnail for a PDF attachment.
   * Leverages 100% in-process Mozilla PDF.js + @napi-rs/canvas + sharp.
   */
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

    // 1. Check if cached thumbnail exists in storage driver
    let blobId: string | null = null;
    let storageNode: any = null;

    if (attachment.fileId && this.storageNodeRepo) {
      try {
        storageNode = await this.storageNodeRepo.findById(attachment.fileId);
        if (storageNode?.blobId) {
          blobId = storageNode.blobId;
        }
      } catch (err: any) {
        this.logger.debug(
          `Could not resolve storage node for attachment ${attachmentId}: ${err?.message}`,
        );
      }
    }

    if (blobId && this.storageDriver) {
      const thumbKey = `thumbnails/${blobId}.webp`;
      try {
        const exists = await this.storageDriver.exists(thumbKey);
        if (exists) {
          const { stream } = await this.storageDriver.getStream(thumbKey);
          const chunks: Buffer[] = [];
          for await (const chunk of stream) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          return {
            buffer: Buffer.concat(chunks),
            mimeType: 'image/webp',
          };
        }
      } catch (err: any) {
        this.logger.debug(
          `Failed reading existing thumbnail from storage driver: ${err?.message}`,
        );
      }
    }

    // 2. Fetch the PDF binary buffer
    let pdfBuffer: Buffer | null = null;
    if (attachment.fileId && this.storagePort?.readOwnedFile) {
      try {
        const fileRecord = await this.storagePort.readOwnedFile({
          fileId: attachment.fileId,
          userId,
        });
        if (fileRecord?.buffer) {
          pdfBuffer = fileRecord.buffer;
        }
      } catch (err: any) {
        this.logger.debug(
          `Failed to read owned file for thumbnail: ${err?.message}`,
        );
      }
    }

    if (!pdfBuffer) {
      throw new NotFoundException(
        `No PDF binary available for attachment ${attachmentId}`,
      );
    }

    // 3. Generate thumbnail via PdfThumbnailService
    if (!this.pdfThumbnailService) {
      throw new NotFoundException('Thumbnail generator service is unavailable');
    }

    const thumbBuffer =
      await this.pdfThumbnailService.generateThumbnail(pdfBuffer);
    if (!thumbBuffer) {
      throw new NotFoundException(
        `Failed to generate thumbnail for attachment ${attachmentId}`,
      );
    }

    // 4. Cache generated thumbnail in storage driver if blobId is known
    if (blobId && this.storageDriver) {
      const thumbKey = `thumbnails/${blobId}.webp`;
      try {
        await this.storageDriver.put(thumbKey, thumbBuffer, {
          mimeType: 'image/webp',
          size: thumbBuffer.length,
        });
        if (storageNode && this.storageNodeRepo) {
          const currentMeta = storageNode.metadata || {};
          storageNode.updateMetadata?.({
            ...currentMeta,
            thumbnail: `/api/files/r2/${encodeURIComponent(thumbKey)}`,
          });
          await this.storageNodeRepo.update(storageNode);
        }
      } catch (err: any) {
        this.logger.warn(
          `Could not persist generated thumbnail to driver: ${err?.message}`,
        );
      }
    }

    return {
      buffer: thumbBuffer,
      mimeType: 'image/webp',
    };
  }

  /**
   * Renames a single attachment file based on explicit name or parent item metadata pattern (Zotero standard).
   */
  async renameAttachment(
    userId: UserId | string,
    attachmentId: AttachmentId | string,
    dto: RenameAttachmentDto,
    projectId?: ProjectId | string,
  ): Promise<{ attachment: any; oldFilename: string; newFilename: string }> {
    const attachment = await this.repo.findFirst(
      {
        id: attachmentId,
        deletedAt: null,
      },
      {
        item: {
          include: {
            contributors: {
              orderBy: { orderIndex: 'asc' },
            },
          },
        },
      },
    );

    if (!attachment) {
      throw new NotFoundException(`Attachment ${attachmentId} not found`);
    }

    // Verify item ownership / project access
    await this.assertItemExists(userId, attachment.itemId, projectId);

    const oldFilename =
      attachment.filename || attachment.name || 'document.pdf';
    let newFilename = '';

    if (dto.filename && dto.filename.trim()) {
      const ext = resolveFileExtension(oldFilename);
      const cleanStem = sanitizeFilenameStem(
        dto.filename.replace(/\.[a-zA-Z0-9]+$/, ''),
      );
      newFilename = `${cleanStem}${ext}`;
    } else {
      const pattern = dto.pattern || DEFAULT_RENAME_PATTERN;
      newFilename = formatAttachmentFilename(
        pattern,
        attachment.item,
        oldFilename,
      );
    }

    if (oldFilename === newFilename) {
      return { attachment, oldFilename, newFilename };
    }

    const updated = await this.repo.renameAttachment(
      attachmentId,
      newFilename,
      attachment.fileId,
    );

    return { attachment: updated, oldFilename, newFilename };
  }

  /**
   * Batch renames attachment files based on parent item metadata according to a pattern (Zotero standard).
   */
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
    const pattern = dto.pattern || DEFAULT_RENAME_PATTERN;
    const whereClause: Prisma.AttachmentWhereInput = {
      deletedAt: null,
    };

    if (dto.attachmentIds && dto.attachmentIds.length > 0) {
      whereClause.id = { in: dto.attachmentIds };
    } else if (dto.itemIds && dto.itemIds.length > 0) {
      whereClause.itemId = { in: dto.itemIds };
    } else {
      throw new BadRequestException(
        'Either itemIds or attachmentIds must be provided',
      );
    }

    const attachments = await this.repo.findMany(whereClause, {
      item: {
        include: {
          contributors: {
            orderBy: { orderIndex: 'asc' },
          },
        },
      },
    });

    const results: Array<{
      attachmentId: string;
      itemId: string;
      oldFilename: string;
      newFilename: string;
    }> = [];

    for (const att of attachments) {
      try {
        // Assert scope permission per item
        await this.assertItemExists(userId, att.itemId, projectId);
        const oldFilename = (att as any).filename || att.name || 'document.pdf';
        const newFilename = formatAttachmentFilename(
          pattern,
          (att as any).item,
          oldFilename,
        );

        if (oldFilename !== newFilename) {
          await this.repo.renameAttachment(
            att.id,
            newFilename,
            att.fileId ?? undefined,
          );
        }

        results.push({
          attachmentId: att.id,
          itemId: att.itemId,
          oldFilename,
          newFilename,
        });
      } catch (err: any) {
        this.logger.warn(
          `Failed to rename attachment ${att.id}: ${err?.message}`,
        );
      }
    }

    return {
      renamedCount: results.filter((r) => r.oldFilename !== r.newFilename)
        .length,
      results,
    };
  }

  /**
   * Resolves the parent itemId for an attachment with domain existence check.
   */
  async resolveAttachmentItemId(
    attachmentId: AttachmentId | string,
  ): Promise<ItemId> {
    const attachment = await this.repo.findUnique(attachmentId);
    if (!attachment?.itemId) {
      throw new NotFoundException(`Attachment ${attachmentId} not found`);
    }
    return attachment.itemId as ItemId;
  }

  /**
   * Resolves an item's target URL for capturing web snapshots.
   */
  async resolveItemUrl(
    itemId: ItemId | string,
    userId: UserId | string,
    projectId?: ProjectId | string,
  ): Promise<string> {
    const item = this.bibliographyFacade
      ? await this.bibliographyFacade.getItem(userId, itemId, projectId)
      : null;
    if (!item) {
      throw new NotFoundException(`Item ${itemId} not found`);
    }
    const itemUrl = (item as any).url || (item as any).fields?.url;
    if (!itemUrl) {
      throw new BadRequestException(
        'No URL found on this item to capture a snapshot.',
      );
    }
    return itemUrl;
  }
}
