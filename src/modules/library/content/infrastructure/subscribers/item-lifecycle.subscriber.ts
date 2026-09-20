import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { OutboxWorker } from '../../../shared-kernel/outbox/outbox.worker';
import { OutboxEvent } from '@prisma/client';
import {
  INTEGRATION_EVENT_TOPICS,
  BaseIntegrationEvent,
  ItemDeletedIntegrationPayload,
} from '../../../shared-kernel/events/integration-events';
import { PrismaService } from '../../../../../core/database/prisma.service';

/**
 * ItemLifecycleSubscriber in Content Bounded Context.
 * Listens to Catalog item deletion events to clean up or soft-delete content attachments.
 */
@Injectable()
export class ItemLifecycleSubscriber implements OnModuleInit {
  private readonly logger = new Logger(ItemLifecycleSubscriber.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly outboxWorker?: OutboxWorker,
  ) {}

  onModuleInit() {
    if (this.outboxWorker) {
      this.outboxWorker.registerHandler(
        INTEGRATION_EVENT_TOPICS.CATALOG_ITEM_DELETED,
        {
          handle: async (event: OutboxEvent) => {
            await this.handleItemDeleted(event.payload as any);
          },
        },
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
      `[ContentSubscriber] Cascading soft-delete to attachments and notes for deleted item ${itemId}`,
    );

    try {
      const tasks: Promise<any>[] = [];
      if (this.prisma?.attachment?.updateMany) {
        tasks.push(
          this.prisma.attachment.updateMany({
            where: { itemId, deletedAt: null },
            data: { deletedAt: new Date() },
          }),
        );
      }
      if (this.prisma?.note?.updateMany) {
        tasks.push(
          this.prisma.note.updateMany({
            where: { itemId, deletedAt: null },
            data: { deletedAt: new Date() },
          }),
        );
      }
      await Promise.all(tasks);
    } catch (err: any) {
      this.logger.warn(
        `[ContentSubscriber] Content cascade cleanup error for item ${itemId}: ${err?.message || err}`,
      );
    }
  }
}
