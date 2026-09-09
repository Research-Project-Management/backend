import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { LIBRARY_EVENT_TYPES } from '../../outbox/outbox.events';
import { FullTextProvider } from '../providers/full-text.provider';
import { PrismaService } from '../../../../core/database/prisma.service';

import { DomainEventEnvelope } from '../../outbox/ports/event-publisher.port';

@Injectable()
export class EventHandler {
  private readonly logger = new Logger(EventHandler.name);

  constructor(
    private readonly fullText: FullTextProvider,
    private readonly prisma: PrismaService,
  ) {}

  @OnEvent(LIBRARY_EVENT_TYPES.ITEM_DELETED, { async: true })
  async handleItemDeleted(event: DomainEventEnvelope) {
    this.logger.debug(
      `[SearchEventHandler] Cleaning up full-text index for deleted item ${event.aggregateId} (workspace: ${event.workspaceId})`,
    );

    try {
      const attachments = await this.prisma.catalogAttachment.findMany({
        where: { catalogItemId: event.aggregateId },
        select: { id: true },
      });

      for (const att of attachments) {
        await this.prisma.fullTextIndex.deleteMany({
          where: { attachmentId: att.id },
        });
      }
    } catch (err: any) {
      this.logger.error(
        `Failed to clean up full-text index for deleted item ${event.aggregateId}: ${err?.message || err}`,
      );
    }
  }

  @OnEvent(LIBRARY_EVENT_TYPES.ATTACHMENT_DELETED, { async: true })
  async handleAttachmentDeleted(event: DomainEventEnvelope) {
    this.logger.debug(
      `[SearchEventHandler] Cleaning up full-text index for deleted attachment ${event.aggregateId}`,
    );

    try {
      await this.prisma.fullTextIndex.deleteMany({
        where: { attachmentId: event.aggregateId },
      });
    } catch (err: any) {
      this.logger.error(
        `Failed to clean up full-text index for attachment ${event.aggregateId}: ${err?.message || err}`,
      );
    }
  }

  @OnEvent(LIBRARY_EVENT_TYPES.ITEM_CREATED, { async: true })
  handleItemCreated(event: DomainEventEnvelope) {
    this.logger.debug(
      `[EventHandler] New item indexed in catalog: ${event.aggregateId} (workspace: ${event.workspaceId})`,
    );
  }
}

export { EventHandler as SearchEventHandler };
