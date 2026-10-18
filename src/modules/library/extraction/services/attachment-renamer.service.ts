import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  Inject,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CATALOG_FACADE, ICatalogFacade } from '@/modules/library/core';
import { AttachmentsRepository } from '@/modules/library/extraction/repositories/attachments.repository';
import {
  formatAttachmentFilename,
  resolveFileExtension,
  sanitizeFilenameStem,
  DEFAULT_RENAME_PATTERN,
} from '@/modules/library/extraction/domain/renamer.domain';
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

  async renameAttachment(
    userId: UserId | string,
    attachmentId: AttachmentId | string,
    dto: RenameAttachmentDto,
    projectId?: ProjectId | string,
  ) {
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

    interface RenameAttachmentRecord {
      id: string;
      itemId: string;
      filename?: string | null;
      fileId?: string | null;
      item?: Parameters<typeof formatAttachmentFilename>[1];
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
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Failed to rename attachment ${att.id}: ${message}`);
      }
    }

    return {
      renamedCount: results.filter((r) => r.oldFilename !== r.newFilename)
        .length,
      results,
    };
  }
}
