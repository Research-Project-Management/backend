/**
 * Formal Typed Integration Events for Cross-Bounded-Context Communication.
 *
 * In a microservices or modular monolith architecture, BCs must communicate
 * through asynchronous integration events rather than direct synchronous service calls.
 */
import { randomUUID } from 'crypto';

export const INTEGRATION_EVENT_TOPICS = {
  CATALOG_ITEM_CREATED: 'library.integration.catalog.item_created',
  CATALOG_ITEM_UPDATED: 'library.integration.catalog.item_updated',
  CATALOG_ITEM_DELETED: 'library.integration.catalog.item_deleted',
  EXTRACTION_ATTACHMENT_EXTRACTED:
    'library.integration.extraction.attachment_extracted',
  INGESTION_COMPLETED: 'library.integration.ingestion.completed',
} as const;

export type LibraryBoundedContext =
  'catalog' | 'sync' | 'extraction' | 'ingestion' | 'citation' | 'search';

export interface BaseIntegrationEvent<T = any> {
  readonly eventId: string;
  readonly topic: string;
  readonly occurredAt: string;
  readonly sourceContext: LibraryBoundedContext;
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
  sourceContext: LibraryBoundedContext,
  payload: T,
  scope: { userId: string; projectId?: string | null },
): BaseIntegrationEvent<T> {
  return {
    eventId: randomUUID(),
    topic,
    occurredAt: new Date().toISOString(),
    sourceContext,
    payload,
    scope,
  };
}

export const INTEGRATION_EVENT_BUS = Symbol('INTEGRATION_EVENT_BUS');

export interface IIntegrationEventBus {
  publish<T>(event: BaseIntegrationEvent<T>): Promise<void>;
  publishBatch<T>(events: BaseIntegrationEvent<T>[]): Promise<void>;
}
