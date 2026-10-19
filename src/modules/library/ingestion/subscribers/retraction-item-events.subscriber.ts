import { Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { LIBRARY_EVENT_TYPES } from '@/modules/library/core';
import { RetractionService } from '@/modules/library/ingestion/services/retraction.service';

const IDENTIFIER_FIELD_GROUPS = ['doi', 'pmid', 'fields', 'metadata'];

@Injectable()
export class RetractionItemEventsSubscriber {
  private readonly logger = new Logger(RetractionItemEventsSubscriber.name);

  constructor(@Optional() private readonly retraction?: RetractionService) {}

  @OnEvent(LIBRARY_EVENT_TYPES.ITEM_UPDATED, { async: true })
  async handleItemUpdated(event: {
    aggregateId?: string;
    userId?: string | null;
    projectId?: string | null;
    payload?: { updatedFields?: string[]; userId?: string; projectId?: string };
  }): Promise<void> {
    if (!this.retraction) return;

    const itemId = event?.aggregateId;
    const userId = event?.userId ?? event?.payload?.userId ?? undefined;
    if (!itemId || !userId) return;

    const updatedFields = event.payload?.updatedFields;
    if (
      Array.isArray(updatedFields) &&
      (updatedFields.includes('retractionCheckedAt') ||
        updatedFields.includes('isRetracted'))
    ) {
      return;
    }
    const mayAffectIdentifier =
      !Array.isArray(updatedFields) ||
      updatedFields.some((f) => IDENTIFIER_FIELD_GROUPS.includes(f));
    if (!mayAffectIdentifier) return;

    try {
      await this.retraction.checkItem(
        userId,
        itemId,
        event.projectId ?? event.payload?.projectId ?? undefined,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Retraction re-check after update skipped for item ${itemId}: ${message}`,
      );
    }
  }
}
