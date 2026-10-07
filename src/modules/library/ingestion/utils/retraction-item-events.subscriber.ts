import { Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { RetractionService } from '../services/retraction.service';

const CATALOG_ITEM_UPDATED_EVENT = 'catalog.item.updated';
const IDENTIFIER_FIELD_GROUPS = ['doi', 'fields'];

@Injectable()
export class RetractionItemEventsSubscriber {
  private readonly logger = new Logger(RetractionItemEventsSubscriber.name);

  constructor(@Optional() private readonly retraction?: RetractionService) {}

  @OnEvent(CATALOG_ITEM_UPDATED_EVENT, { async: true })
  async handleItemUpdated(event: {
    aggregateId?: string;
    userId?: string | null;
    projectId?: string | null;
    payload?: { updatedFields?: string[] };
  }): Promise<void> {
    if (!this.retraction) return;

    const itemId = event?.aggregateId;
    const userId = event?.userId ?? undefined;
    if (!itemId || !userId) return;

    const updatedFields = event.payload?.updatedFields;
    const mayAffectIdentifier =
      !Array.isArray(updatedFields) ||
      updatedFields.some((f) => IDENTIFIER_FIELD_GROUPS.includes(f));
    if (!mayAffectIdentifier) return;

    try {
      await this.retraction.checkItem(
        userId,
        itemId,
        event.projectId ?? undefined,
      );
    } catch (err: any) {
      this.logger.warn(
        `Retraction re-check after update skipped for item ${itemId}: ${err?.message || err}`,
      );
    }
  }
}
