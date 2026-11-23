import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  LIBRARY_EVENT_TYPES,
  DomainEventEnvelope,
  extractFileIdFromUrl,
} from '@/modules/library/core';
import { FILES_PORT, IFilesPort } from '@/modules/files';
import { AnnotationsRepository } from '@/modules/library/extraction/repositories/annotations.repository';
import { AttachmentsRepository } from '@/modules/library/extraction/repositories/attachments.repository';

/**
 * ItemLifecycleSubscriber in Extraction Bounded Context.
 * Listens to Catalog item deletion events to clean up or soft-delete content attachments and annotations.
 */
@Injectable()
export class ItemLifecycleSubscriber {
  private readonly logger = new Logger(ItemLifecycleSubscriber.name);

  constructor(
    private readonly attachmentsRepo: AttachmentsRepository,
    @Optional()
    private readonly annotationsRepo?: AnnotationsRepository,
    @Optional()
    @Inject(FILES_PORT)
    private readonly filesPort?: IFilesPort,
  ) {}

  @OnEvent(LIBRARY_EVENT_TYPES.ITEM_PURGED, { async: true })
  async handleItemPurged(event: unknown): Promise<void> {
    const payload = event as
      | {
          id?: string;
          aggregateId?: string;
          spaceId?: string;
          projectId?: string;
          userId?: string;
          filePaths?: string[];
          cascadedInTx?: boolean;
          storageDeletedInTx?: boolean;
          payload?: {
            id?: string;
            itemId?: string;
            itemIds?: string[];
            spaceId?: string;
            projectId?: string;
            userId?: string;
            filePaths?: string[];
            cascadedInTx?: boolean;
            storageDeletedInTx?: boolean;
          };
        }
      | null
      | undefined;
    if (
      (payload?.cascadedInTx || payload?.payload?.cascadedInTx) &&
      (payload?.storageDeletedInTx || payload?.payload?.storageDeletedInTx)
    ) {
      return;
    }
    const itemId =
      payload?.id ||
      payload?.aggregateId ||
      payload?.payload?.id ||
      payload?.payload?.itemId;
    if (!itemId) return;

    const rawFilePaths =
      payload?.payload?.filePaths ?? payload?.filePaths ?? [];
    const payloadFilePaths = Array.isArray(rawFilePaths)
      ? rawFilePaths.filter(
          (fp): fp is string => typeof fp === 'string' && fp.trim().length > 0,
        )
      : [];

    this.logger.log(
      `[ExtractionSubscriber] Purging attachments and annotations for purged item ${itemId}`,
    );

    try {
      const candidateFileIdsToDelete = new Set<string>(payloadFilePaths);
      let resolvedSpaceId =
        payload?.spaceId ??
        payload?.payload?.spaceId ??
        payload?.projectId ??
        payload?.payload?.projectId ??
        payload?.userId ??
        payload?.payload?.userId;
      if (this.filesPort?.deleteFile && this.attachmentsRepo?.findMany) {
        const attachments = await this.attachmentsRepo.findMany(
          { itemId },
          { revisions: true, item: { select: { spaceId: true } } },
        );
        for (const attachment of attachments || []) {
          const attItemSpaceId = (
            attachment as { item?: { spaceId?: string } | null }
          )?.item?.spaceId;
          if (!resolvedSpaceId && attItemSpaceId) {
            resolvedSpaceId = attItemSpaceId;
          }
          const attFileId =
            attachment.fileId || extractFileIdFromUrl(attachment.url);
          if (attFileId) candidateFileIdsToDelete.add(attFileId);
          const revisions = (
            attachment as {
              revisions?: Array<{
                fileId?: string | null;
                url?: string | null;
              }>;
            }
          ).revisions;
          if (Array.isArray(revisions)) {
            for (const rev of revisions) {
              const revFileId =
                rev.fileId || extractFileIdFromUrl(rev.url ?? undefined);
              if (revFileId) candidateFileIdsToDelete.add(revFileId);
            }
          }
        }
      }

      if (this.annotationsRepo) {
        await this.annotationsRepo.deleteManyByItemId(itemId);
      }
      if (this.attachmentsRepo?.deleteManyByItemId) {
        await this.attachmentsRepo.deleteManyByItemId(itemId);
      }

      if (this.filesPort?.deleteFile && candidateFileIdsToDelete.size > 0) {
        const candidateFileIds = Array.from(candidateFileIdsToDelete);
        const deleteTarget = resolvedSpaceId
          ? { spaceId: resolvedSpaceId }
          : undefined;
        await Promise.all(
          candidateFileIds.map(async (fid) => {
            try {
              await this.filesPort!.deleteFile(fid, deleteTarget);
            } catch (delErr: unknown) {
              const msg =
                delErr instanceof Error ? delErr.message : String(delErr);
              this.logger.warn(
                `[ExtractionSubscriber] Failed to delete storage file ${fid} for purged item ${itemId}: ${msg}`,
              );
            }
          }),
        );
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `[ExtractionSubscriber] Cascade purge error for item ${itemId}: ${errorMessage}`,
      );
    }
  }

  @OnEvent(LIBRARY_EVENT_TYPES.ITEM_DELETED, { async: true })
  async handleItemDeleted(
    event:
      | DomainEventEnvelope
      | {
          aggregateId?: string;
          cascadedInTx?: boolean;
          payload?: { itemId?: string; cascadedInTx?: boolean };
        },
  ): Promise<void> {
    const rawPayload = (
      event as
        { payload?: { itemId?: string; cascadedInTx?: boolean } } | undefined
    )?.payload;
    if (
      (event as { cascadedInTx?: boolean } | undefined)?.cascadedInTx ||
      rawPayload?.cascadedInTx
    ) {
      return;
    }
    const itemId = event?.aggregateId || rawPayload?.itemId;
    if (!itemId) return;

    this.logger.log(
      `[ExtractionSubscriber] Cascading soft-delete to attachments and annotations for deleted item ${itemId}`,
    );

    try {
      const attachments = await this.attachmentsRepo.findMany({
        itemId,
        deletedAt: null,
      });
      const attachmentIds = (attachments || []).map(
        (attachment: { id: string }) => attachment.id,
      );

      if (attachmentIds.length > 0 && this.annotationsRepo) {
        await this.annotationsRepo.softDeleteByAttachmentIds(attachmentIds);
      }
      await this.attachmentsRepo.softDeleteByItemId(itemId);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `[ExtractionSubscriber] Cascade cleanup error for item ${itemId}: ${errorMessage}`,
      );
    }
  }

  @OnEvent(LIBRARY_EVENT_TYPES.ITEM_RESTORED, { async: true })
  async handleItemRestored(
    event:
      | DomainEventEnvelope
      | {
          aggregateId?: string;
          cascadedInTx?: boolean;
          payload?: { itemId?: string; id?: string; cascadedInTx?: boolean };
        },
  ): Promise<void> {
    const rawPayload = event && 'payload' in event ? event.payload : undefined;
    if (
      (event as { cascadedInTx?: boolean } | undefined)?.cascadedInTx ||
      (rawPayload as { cascadedInTx?: boolean } | undefined)?.cascadedInTx
    ) {
      return;
    }
    const itemId =
      event?.aggregateId ||
      (rawPayload as { itemId?: string; id?: string } | undefined)?.itemId ||
      (rawPayload as { itemId?: string; id?: string } | undefined)?.id;
    if (!itemId) return;

    const deletedAtRaw = (
      rawPayload as { deletedAt?: string | Date } | undefined
    )?.deletedAt;
    const itemDeletedAt = deletedAtRaw ? new Date(deletedAtRaw) : undefined;

    this.logger.log(
      `[ExtractionSubscriber] Verifying attachment counts for restored item ${itemId}`,
    );

    try {
      if (
        itemDeletedAt &&
        !isNaN(itemDeletedAt.getTime()) &&
        this.attachmentsRepo?.findMany
      ) {
        const trashedAttachments = await this.attachmentsRepo.findMany({
          itemId,
          deletedAt: { gte: itemDeletedAt },
        });
        const attachmentIds = (trashedAttachments || []).map(
          (attachment: { id: string }) => attachment.id,
        );

        if (attachmentIds.length > 0 && this.annotationsRepo) {
          await this.annotationsRepo.restoreByAttachmentIds?.(attachmentIds);
        }
      }
      await this.attachmentsRepo?.syncItemAttachmentCounts?.(itemId);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `[ExtractionSubscriber] Cascade restore error for item ${itemId}: ${errorMessage}`,
      );
    }
  }
}
