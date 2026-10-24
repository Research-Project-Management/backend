import {
  Injectable,
  Logger,
  Optional,
  Inject,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  LIBRARY_EVENT_TYPES,
  DomainEventEnvelope,
  extractFileIdFromUrl,
} from '@/modules/library/core';
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
          payload?: { id?: string; itemId?: string };
        }
      | null
      | undefined;
    const itemId =
      payload?.id ||
      payload?.aggregateId ||
      payload?.payload?.id ||
      payload?.payload?.itemId;
    if (!itemId) return;

    this.logger.log(
      `[ExtractionSubscriber] Purging attachments and annotations for purged item ${itemId}`,
    );

    try {
      if (this.storagePort?.deleteFile && this.attachmentsRepository?.findMany) {
        const attachments = await this.attachmentsRepository.findMany(
          { itemId },
          { revisions: true },
        );
        const fileIdsToDelete = new Set<string>();
        for (const att of attachments || []) {
          const attFileId = att.fileId || extractFileIdFromUrl(att.url);
          if (attFileId) fileIdsToDelete.add(attFileId);
          const revisions = (
            att as {
              revisions?: Array<{ fileId?: string | null; url?: string | null }>;
            }
          ).revisions;
          if (Array.isArray(revisions)) {
            for (const rev of revisions) {
              const revFileId =
                rev.fileId || extractFileIdFromUrl(rev.url ?? undefined);
              if (revFileId) fileIdsToDelete.add(revFileId);
            }
          }
        }
        for (const fid of fileIdsToDelete) {
          try {
            await this.storagePort.deleteFile(fid);
          } catch (delErr: unknown) {
            const msg =
              delErr instanceof Error ? delErr.message : String(delErr);
            this.logger.warn(
              `[ExtractionSubscriber] Failed to delete storage file ${fid} for purged item ${itemId}: ${msg}`,
            );
          }
        }
      }

      if (this.annotationsRepository) {
        await this.annotationsRepository.deleteManyByItemId(itemId);
      }
      if (this.attachmentsRepository?.deleteManyByItemId) {
        await this.attachmentsRepository.deleteManyByItemId(itemId);
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
      | { aggregateId?: string; payload?: { itemId?: string } },
  ): Promise<void> {
    const itemId =
      event?.aggregateId ||
      (event?.payload as { itemId?: string } | undefined)?.itemId;
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
      | { aggregateId?: string; payload?: { itemId?: string; id?: string } },
  ): Promise<void> {
    const rawPayload = event && 'payload' in event ? event.payload : undefined;
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
      // Note: CommandRepository.restore already cascades restore inside the DB transaction.
      // Only restore attachments/annotations if itemDeletedAt is explicitly provided so we never
      // blindly resurrect attachments that were deleted long before the item was deleted.
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
