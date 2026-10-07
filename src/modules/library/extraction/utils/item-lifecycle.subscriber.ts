import {
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
  Inject,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { IOutboxRegistry, OUTBOX_REGISTRY_PORT } from '../../shared-kernel';
import { OutboxEvent } from '@prisma/client';
import {
  INTEGRATION_EVENT_TOPICS,
  BaseIntegrationEvent,
  ItemDeletedIntegrationPayload,
} from '../../shared-kernel/events/integration-events';
import { AnnotationsRepository } from '../repositories/annotations.repository';
import { AttachmentsRepository } from '../repositories/attachments.repository';

/**
 * ItemLifecycleSubscriber in Extraction Bounded Context.
 * Listens to Catalog item deletion events to clean up or soft-delete content attachments and annotations.
 */
@Injectable()
export class ItemLifecycleSubscriber implements OnModuleInit {
  private readonly logger = new Logger(ItemLifecycleSubscriber.name);

  constructor(
    private readonly attachmentsRepository: AttachmentsRepository,
    private readonly annotationsRepository: AnnotationsRepository,
    @Optional()
    @Inject(OUTBOX_REGISTRY_PORT)
    private readonly outboxWorker?: IOutboxRegistry,
  ) {}

  onModuleInit() {
    if (this.outboxWorker) {
      this.outboxWorker.registerHandler(
        INTEGRATION_EVENT_TOPICS.CATALOG_ITEM_DELETED,
        {
          handle: async (event: OutboxEvent) => {
            await this.handleItemDeleted(
              event.payload as unknown as BaseIntegrationEvent<ItemDeletedIntegrationPayload>,
            );
          },
        },
      );
      this.outboxWorker.registerHandler('library.item.purged', {
        handle: async (event: OutboxEvent) => {
          await this.handleItemPurged(event.payload);
        },
      });
    }
  }

  @OnEvent('library.item.purged', { async: true })
  async handleItemPurged(event: any): Promise<void> {
    const itemId = event?.id || event?.payload?.id;
    if (!itemId) return;

    this.logger.log(
      `[ExtractionSubscriber] Purging attachments and annotations for purged item ${itemId}`,
    );

    try {
      await this.annotationsRepository
        .deleteManyByItemId(itemId)
        .catch(() => {});
      await this.attachmentsRepository
        .deleteManyByItemId(itemId)
        .catch(() => {});
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `[ExtractionSubscriber] Cascade purge error for item ${itemId}: ${errorMessage}`,
      );
    }
  }

  @OnEvent(INTEGRATION_EVENT_TOPICS.CATALOG_ITEM_DELETED, { async: true })
  async handleItemDeleted(
    event: BaseIntegrationEvent<ItemDeletedIntegrationPayload>,
  ): Promise<void> {
    const itemId = event?.payload?.itemId;
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

      if (attachmentIds.length > 0) {
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
}
