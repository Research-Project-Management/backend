import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { LIBRARY_EVENT_TYPES, DomainEventEnvelope, extractFileIdFromUrl } from '@/modules/library/core';
import { STORAGE_PORT, IStoragePort } from '@/modules/storage/storage.port';
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
    private readonly attachmentsRepository: AttachmentsRepository,
    @Optional()
    private readonly annotationsRepository?: AnnotationsRepository,
    @Optional()
    @Inject(STORAGE_PORT)
    private readonly storagePort?: IStoragePort,
  ) {}

  @OnEvent(LIBRARY_EVENT_TYPES.ITEM_PURGED, { async: true })
  async handleItemPurged(event: unknown): Promise<void> {
    const payload = event as
      | {
          id?: string;
          aggregateId?: string;
          filePaths?: string[];
          cascadedInTx?: boolean;
          storageDeletedInTx?: boolean;
          payload?: {
            id?: string;
            itemId?: string;
            itemIds?: string[];
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
      if (this.storagePort?.deleteFile && this.attachmentsRepository?.findMany) {
        const attachments = await this.attachmentsRepository.findMany(
          { itemId },
          { revisions: true },
        );
        for (const att of attachments || []) {
          const attFileId = att.fileId || extractFileIdFromUrl(att.url);
          if (attFileId) candidateFileIdsToDelete.add(attFileId);
          const revisions = (
            att as {
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

      if (this.annotationsRepository) {
        await this.annotationsRepository.deleteManyByItemId(itemId);
      }
      if (this.attachmentsRepository?.deleteManyByItemId) {
        await this.attachmentsRepository.deleteManyByItemId(itemId);
      }

      if (this.storagePort?.deleteFile && candidateFileIdsToDelete.size > 0) {
        const candidateFileIds = Array.from(candidateFileIdsToDelete);
        await Promise.all(
          candidateFileIds.map(async (fid) => {
            try {
              if (
                typeof this.attachmentsRepository?.countFileIdReferences ===
                'function'
              ) {
                const remainingRefs =
                  await this.attachmentsRepository.countFileIdReferences(
                    fid,
                    undefined,
                    undefined,
                    itemId,
                  );
                if (typeof remainingRefs === 'number' && remainingRefs > 0) {
                  return;
                }
              }
              await this.storagePort!.deleteFile(fid);
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
      | { aggregateId?: string; cascadedInTx?: boolean; payload?: { itemId?: string; cascadedInTx?: boolean } },
  ): Promise<void> {
    const rawPayload = (event as { payload?: { itemId?: string; cascadedInTx?: boolean } } | undefined)?.payload;
    if ((event as { cascadedInTx?: boolean } | undefined)?.cascadedInTx || rawPayload?.cascadedInTx) {
      return;
    }
    const itemId =
      event?.aggregateId ||
      rawPayload?.itemId;
    if (!itemId) return;

    this.logger.log(
      `[ExtractionSubscriber] Cascading soft-delete to attachments and annotations for deleted item ${itemId}`,
    );

    try {
      const attachments = await this.attachmentsRepository.findMany({
        itemId,
        deletedAt: null,
      });
      const attachmentIds = (attachments || []).map(
        (attachment: { id: string }) => attachment.id,
      );

      if (attachmentIds.length > 0 && this.annotationsRepository) {
        await this.annotationsRepository.softDeleteByAttachmentIds(
          attachmentIds,
        );
      }
      await this.attachmentsRepository.softDeleteByItemId(itemId);
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
      | { aggregateId?: string; cascadedInTx?: boolean; payload?: { itemId?: string; id?: string; cascadedInTx?: boolean } },
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
        this.attachmentsRepository?.findMany
      ) {
        const trashedAttachments = await this.attachmentsRepository.findMany({
          itemId,
          deletedAt: { gte: itemDeletedAt },
        });
        const attachmentIds = (trashedAttachments || []).map(
          (attachment: { id: string }) => attachment.id,
        );

        if (attachmentIds.length > 0 && this.annotationsRepository) {
          await this.annotationsRepository.restoreByAttachmentIds?.(
            attachmentIds,
          );
        }
      }
      await this.attachmentsRepository?.syncItemAttachmentCounts?.(itemId);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `[ExtractionSubscriber] Cascade restore error for item ${itemId}: ${errorMessage}`,
      );
    }
  }
}
