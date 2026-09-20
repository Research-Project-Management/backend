import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { LIBRARY_EVENT_TYPES } from '../../../shared-kernel/outbox/outbox.events';
import { FullTextProvider } from '../../infrastructure/providers/full-text.provider';
import { PrismaService } from '../../../../../core/database/prisma.service';

import { DomainEventEnvelope } from '../../../shared-kernel/outbox/ports/event-publisher.port';

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
      `[SearchEventHandler] Cleaning up full-text index for deleted item ${event.aggregateId} (scope: ${event.scopeId || (event as any).userId || (event as any).projectId})`,
    );

    try {
      const attachments = await this.prisma.attachment.findMany({
        where: { itemId: event.aggregateId },
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
      `[EventHandler] New item indexed in library: ${event.aggregateId} (scope: ${event.scopeId || (event as any).userId || (event as any).projectId})`,
    );
  }
}
