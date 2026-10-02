import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { OutboxWorker } from '../../../sync';
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
      this.outboxWorker.registerHandler('library.item.purged', {
        handle: async (event: OutboxEvent) => {
          await this.handleItemPurged(event.payload as any);
        },
      });
    }
  }

  @OnEvent('library.item.purged', { async: true })
  async handleItemPurged(event: any): Promise<void> {
    const itemId = event?.id || event?.payload?.id;
    if (!itemId) return;

    this.logger.log(
      `[ContentSubscriber] Purging attachments, notes, and annotations for purged item ${itemId}`,
    );

    try {
      if (this.prisma?.annotation?.deleteMany) {
        await this.prisma.annotation
          .deleteMany({
            where: { attachment: { itemId } },
          })
          .catch(() => {});
      }
      if (this.prisma?.attachment?.deleteMany) {
        await this.prisma.attachment
          .deleteMany({
            where: { itemId },
          })
          .catch(() => {});
      }
      if (this.prisma?.note?.deleteMany) {
        await this.prisma.note
          .deleteMany({
            where: { itemId },
          })
          .catch(() => {});
      }
    } catch (err: any) {
      this.logger.warn(
        `[ContentSubscriber] Content cascade purge error for item ${itemId}: ${err?.message || err}`,
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
      `[ContentSubscriber] Cascading soft-delete to attachments, notes, and annotations for deleted item ${itemId}`,
    );

    try {
      const now = new Date();
      const attachments = await this.prisma.attachment.findMany({
        where: { itemId },
        select: { id: true },
      });
      const attachmentIds = attachments.map((a: any) => a.id);

      const performUpdates = async (tx: any) => {
        if (attachmentIds.length > 0) {
          await tx.annotation.updateMany({
            where: {
              attachmentId: { in: attachmentIds },
              deletedAt: null,
            },
            data: { deletedAt: now },
          });
        }
        await tx.attachment.updateMany({
          where: { itemId, deletedAt: null },
          data: { deletedAt: now },
        });
        await tx.note.updateMany({
          where: { itemId, deletedAt: null },
          data: { deletedAt: now },
        });
      };

      if (typeof this.prisma.$transaction === 'function') {
        await this.prisma.$transaction(performUpdates);
      } else {
        await performUpdates(this.prisma);
      }
    } catch (err: any) {
      this.logger.warn(
        `[ContentSubscriber] Content cascade cleanup error for item ${itemId}: ${err?.message || err}`,
      );
    }
  }
}
