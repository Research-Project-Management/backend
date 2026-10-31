import { Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  LIBRARY_EVENT_TYPES,
  ReconcileExtractedCandidatePayload,
} from '@/modules/library/core';
import { RetractionService } from '@/modules/library/ingestion/services/retraction.service';
import { MetadataResolverService } from '@/modules/library/ingestion/services/metadata-resolver.service';

const IDENTIFIER_FIELD_GROUPS = ['doi', 'pmid', 'fields', 'metadata'];

@Injectable()
export class RetractionItemEventsSubscriber {
  private readonly logger = new Logger(RetractionItemEventsSubscriber.name);

  constructor(
    @Optional() private readonly retraction?: RetractionService,
    @Optional() private readonly metadataResolver?: MetadataResolverService,
  ) {}

  @OnEvent(LIBRARY_EVENT_TYPES.ATTACHMENT_METADATA_EXTRACTED, { async: true })
  async handleAttachmentMetadataExtracted(
    event: ReconcileExtractedCandidatePayload,
  ): Promise<void> {
    if (!this.metadataResolver || !event?.itemId || !event?.userId) return;
    try {
      await this.metadataResolver.reconcileExtractedCandidate(event);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Single-authority reconciliation after extraction skipped for item ${event.itemId}: ${message}`,
      );
    }
  }

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

    const payload = event.payload as
      | {
          updatedFields?: string[];
          userId?: string;
          projectId?: string;
          source?: string;
          doi?: string | null;
          pmid?: string | null;
          metadata?: { doi?: string | null; pmid?: string | null };
        }
      | undefined;
    const updatedFields = payload?.updatedFields;
    const source = payload?.source;
    if (
      source === 'retraction_watch' ||
      (Array.isArray(updatedFields) &&
        (updatedFields.includes('retractionCheckedAt') ||
          updatedFields.includes('isRetracted')))
    ) {
      return;
    }
    const hasExplicitIdentifierInPayload = Boolean(
      payload?.doi ||
        payload?.pmid ||
        payload?.metadata?.doi ||
        payload?.metadata?.pmid,
    );
    const mayAffectIdentifier = Array.isArray(updatedFields)
      ? updatedFields.some((f) => IDENTIFIER_FIELD_GROUPS.includes(f))
      : hasExplicitIdentifierInPayload;
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
