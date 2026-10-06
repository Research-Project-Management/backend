import { Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { RetractionService } from '../services/retraction.service';

/** Event emitted by the Catalog aggregate when an item's metadata changes. */
const CATALOG_ITEM_UPDATED_EVENT = 'catalog.item.updated';

/** Fields whose change can alter the DOI/PMID used for retraction matching. */
const IDENTIFIER_FIELD_GROUPS = ['doi', 'fields'];

/**
 * Re-checks an item against Retraction Watch when it is edited, mirroring
 * Zotero's "check on add or modify". Listens to Catalog events so the Catalog
 * module never calls Ingestion synchronously.
 */
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
    // Without field info, be conservative and re-check; otherwise only react
    // to edits that may touch an identifier (doi, or pmid inside `fields`).
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
