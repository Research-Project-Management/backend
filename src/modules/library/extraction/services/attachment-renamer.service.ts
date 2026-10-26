import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  Inject,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RedisCacheService } from '@/core';
import {
  CATALOG_FACADE,
  ICatalogFacade,
  LIBRARY_REDIS_KEYS,
  LIBRARY_EVENT_TYPES,
  normalizeProjectScopeId,
  formatAttachmentFilename,
  resolveFileExtension,
  sanitizeFilenameStem,
  DEFAULT_RENAME_PATTERN,
  TransactionHelpers,
} from '@/modules/library/core';
import { TransactionService } from '@/modules/library/sync';
import { AttachmentsRepository } from '@/modules/library/extraction/repositories/attachments.repository';
import type {
  RenameAttachmentDto,
  BatchRenameAttachmentsDto,
} from '@/modules/library/extraction/dto/attachments.dto';
import {
  UserId,
  AttachmentId,
  ProjectId,
} from '@/modules/library/core/types/branded.types';

@Injectable()
export class AttachmentRenamerService {
  private readonly logger = new Logger(AttachmentRenamerService.name);

  constructor(
    private readonly repo: AttachmentsRepository,
    @Optional()
    @Inject(CATALOG_FACADE)
    private readonly catalogGateway?: ICatalogFacade,
    @Optional()
    private readonly cache?: RedisCacheService,
    @Optional()
    private readonly libraryTx?: TransactionService,
  ) {}

  private async invalidateAttachmentCache(
    itemId: string,
    userId: string,
    projectId?: string,
  ): Promise<void> {
    if (!this.cache) return;
    try {
      const validProjectId = normalizeProjectScopeId(projectId);
      const scopeId = validProjectId || userId;
      const tasks: Promise<unknown>[] = [
        this.cache.del(LIBRARY_REDIS_KEYS.item(itemId)),
        this.cache.del(LIBRARY_REDIS_KEYS.itemDetails(itemId)),
        this.cache.del(`library:item:${itemId}:attachments`),
        this.cache.delPattern(LIBRARY_REDIS_KEYS.itemPattern(itemId)),
        this.cache.delPattern(LIBRARY_REDIS_KEYS.itemsPattern(scopeId)),
      ];
      if (validProjectId) {
        tasks.push(
          this.cache.delPattern(
            LIBRARY_REDIS_KEYS.itemsPattern(`proj:${validProjectId}`),
          ),
          this.cache.delPattern(LIBRARY_REDIS_KEYS.itemsPattern(userId)),
        );
      }
      await Promise.all(tasks);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to invalidate attachment rename cache: ${msg}`);
    }
  }

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

  async renameAttachment(
    userId: UserId | string,
    attachmentId: AttachmentId | string,
    dto: RenameAttachmentDto,
    projectId?: ProjectId | string,
  ) {
    const validProjectId = normalizeProjectScopeId(projectId);
    const attachment = await this.repo.findFirst(
      {
        id: attachmentId,
        deletedAt: null,
        item: validProjectId
          ? { projectId: validProjectId, deletedAt: null }
          : { userId, projectId: null, deletedAt: null },
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

    await this.assertItemExists(userId, attachment.itemId, projectId);

    const oldFilename = attachment.filename || 'document.pdf';
    let newFilename = '';

    if (dto.filename && dto.filename.trim()) {
      const ext = resolveFileExtension(oldFilename);
      const extCleanupRegex = new RegExp(
        `(?:${ext.replace('.', '\\.')}|\\.[a-zA-Z0-9]{2,5})+$`,
        'i',
      );
      const cleanStem = sanitizeFilenameStem(
        dto.filename.trim().replace(extCleanupRegex, ''),
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
      attachment.fileId ?? undefined,
    );

    const effectiveProjectId =
      validProjectId ||
      (attachment.item as { projectId?: string | null } | undefined)
        ?.projectId ||
      undefined;

    if (typeof this.libraryTx?.executeInTransaction === 'function') {
      await this.libraryTx.executeInTransaction(
        async (_tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
          const eventScope = { userId, projectId: effectiveProjectId };
          await helpers.appendChange(eventScope, {
            entityType: 'Attachment',
            entityId: attachmentId,
            action: 'update',
            version: 1,
            data: updated ?? {
              id: attachmentId,
              itemId: attachment.itemId,
              filename: newFilename,
            },
          });
          await helpers.publishOutbox(
            eventScope,
            attachmentId,
            'library.attachment.updated',
            updated ?? {
              id: attachmentId,
              itemId: attachment.itemId,
              filename: newFilename,
            },
          );
          await helpers.publishOutbox(
            eventScope,
            attachment.itemId,
            LIBRARY_EVENT_TYPES.ITEM_UPDATED,
            {
              id: attachment.itemId,
              attachmentId,
              filename: newFilename,
            },
          );
        },
      );
    }

    await this.invalidateAttachmentCache(
      attachment.itemId,
      userId,
      effectiveProjectId,
    );

    return { attachment: updated, oldFilename, newFilename };
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
    const pattern = dto.pattern || DEFAULT_RENAME_PATTERN;
    const validProjectId = normalizeProjectScopeId(projectId);
    const whereClause: Prisma.AttachmentWhereInput = {
      deletedAt: null,
      item: validProjectId
        ? { projectId: validProjectId, deletedAt: null }
        : { userId, projectId: null, deletedAt: null },
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

    interface RenameAttachmentRecord {
      id: string;
      itemId: string;
      filename?: string | null;
      fileId?: string | null;
      item?: Parameters<typeof formatAttachmentFilename>[1] & {
        projectId?: string | null;
      };
    }
    const attachments = (await this.repo.findMany(whereClause, {
      item: {
        include: {
          contributors: {
            orderBy: { orderIndex: 'asc' },
          },
        },
      },
    })) as RenameAttachmentRecord[];

    const results: Array<{
      attachmentId: string;
      itemId: string;
      oldFilename: string;
      newFilename: string;
    }> = [];

    const verifiedItemIds = new Set<string>();
    const invalidItemIds = new Set<string>();
    const updatesToPersist: Array<{
      id: string;
      itemId: string;
      projectId?: string;
      filename: string;
      fileId?: string;
    }> = [];

    for (const att of attachments) {
      try {
        if (invalidItemIds.has(att.itemId)) {
          continue;
        }
        if (!verifiedItemIds.has(att.itemId)) {
          try {
            await this.assertItemExists(userId, att.itemId, projectId);
            verifiedItemIds.add(att.itemId);
          } catch (err: unknown) {
            invalidItemIds.add(att.itemId);
            throw err;
          }
        }
        const oldFilename = att.filename || 'document.pdf';
        const newFilename = formatAttachmentFilename(
          pattern,
          att.item || {},
          oldFilename,
        );

        if (oldFilename !== newFilename) {
          updatesToPersist.push({
            id: att.id,
            itemId: att.itemId,
            projectId: projectId || att.item?.projectId || undefined,
            filename: newFilename,
            fileId: att.fileId ?? undefined,
          });
        }

        results.push({
          attachmentId: att.id,
          itemId: att.itemId,
          oldFilename,
          newFilename,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Failed to rename attachment ${att.id}: ${message}`);
      }
    }

    if (updatesToPersist.length > 0) {
      await this.repo.batchRename(updatesToPersist);

      if (typeof this.libraryTx?.executeInTransaction === 'function') {
        await this.libraryTx.executeInTransaction(
          async (_tx: Prisma.TransactionClient, helpers: TransactionHelpers) => {
            const eventScope = { userId, projectId: validProjectId };
            for (const u of updatesToPersist) {
              const scope = { userId, projectId: u.projectId || validProjectId };
              await helpers.appendChange(scope, {
                entityType: 'Attachment',
                entityId: u.id,
                action: 'update',
                version: 1,
                data: {
                  id: u.id,
                  itemId: u.itemId,
                  filename: u.filename,
                },
              });
              await helpers.publishOutbox(
                scope,
                u.id,
                'library.attachment.updated',
                {
                  id: u.id,
                  itemId: u.itemId,
                  filename: u.filename,
                },
              );
            }
            const uniqueItems = new Set(updatesToPersist.map((u) => u.itemId));
            for (const itemId of uniqueItems) {
              await helpers.publishOutbox(
                eventScope,
                itemId,
                LIBRARY_EVENT_TYPES.ITEM_UPDATED,
                { id: itemId },
              );
            }
          },
        );
      }

      const uniqueRenamedItemIds = new Map<string, string | undefined>();
      for (const u of updatesToPersist) {
        uniqueRenamedItemIds.set(u.itemId, u.projectId);
      }
      await Promise.all(
        Array.from(uniqueRenamedItemIds.entries()).map(
          ([renamedItemId, itemProjectId]) =>
            this.invalidateAttachmentCache(
              renamedItemId,
              userId,
              itemProjectId,
            ),
        ),
      );
    }

    return {
      renamedCount: updatesToPersist.length,
      results,
    };
  }
}
