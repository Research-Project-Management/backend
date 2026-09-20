/**
 * Formal Typed Integration Events for Cross-Bounded-Context Communication.
 *
 * In a microservices or modular monolith architecture, BCs must communicate
 * through asynchronous integration events rather than direct synchronous service calls.
 */

export const INTEGRATION_EVENT_TOPICS = {
  CATALOG_ITEM_CREATED: 'library.integration.catalog.item_created',
  CATALOG_ITEM_UPDATED: 'library.integration.catalog.item_updated',
  CATALOG_ITEM_DELETED: 'library.integration.catalog.item_deleted',
  CONTENT_ATTACHMENT_EXTRACTED:
    'library.integration.content.attachment_extracted',
  PROCESSING_INGESTION_COMPLETED:
    'library.integration.processing.ingestion_completed',
} as const;

export interface BaseIntegrationEvent<T = any> {
  readonly eventId: string;
  readonly topic: string;
  readonly occurredAt: string;
  readonly sourceContext: 'catalog' | 'content' | 'processing' | 'discovery';
  readonly payload: T;
  readonly scope: {
    userId: string;
    projectId?: string | null;
  };
}

export interface ItemCreatedIntegrationPayload {
  itemId: string;
  title: string;
  itemType: string;
  doi?: string | null;
  citationKey?: string | null;
  abstract?: string | null;
  year?: number | null;
}

export interface ItemUpdatedIntegrationPayload {
  itemId: string;
  title: string;
  version: number;
  updatedFields: string[];
}

export interface ItemDeletedIntegrationPayload {
  itemId: string;
  version: number;
}

export interface AttachmentExtractedIntegrationPayload {
  attachmentId: string;
  itemId: string;
  pageCount: number;
  extractedTextLength?: number;
}

export interface IngestionCompletedIntegrationPayload {
  runId: string;
  itemId?: string | null;
  sourceType: string;
  itemCount: number;
}

export function createIntegrationEvent<T>(
  topic: string,
  sourceContext: 'catalog' | 'content' | 'processing' | 'discovery',
  payload: T,
  scope: { userId: string; projectId?: string | null },
): BaseIntegrationEvent<T> {
  return {
    eventId: crypto.randomUUID(),
    topic,
    occurredAt: new Date().toISOString(),
    sourceContext,
    payload,
    scope,
  };
}
