/**
 * Ingestion Queue Constants
 *
 * Priority-based queue routing:
 * - PRIORITY queue: Premium users, immediate batch imports, retries (concurrency: 8)
 * - STANDARD queue: Free-tier users, background sync (concurrency: 4)
 * - CAPTURE queue: URL capture jobs, isolated from pipeline (concurrency: 4)
 */
export const LIBRARY_INGESTION_QUEUE_PRIORITY =
  process.env.LIBRARY_INGESTION_QUEUE_PRIORITY ||
  'flux:library:ingestion:priority';

export const LIBRARY_INGESTION_QUEUE_STANDARD =
  process.env.LIBRARY_INGESTION_QUEUE_STANDARD ||
  'flux:library:ingestion:standard';

export const LIBRARY_INGESTION_QUEUE_CAPTURE =
  process.env.LIBRARY_INGESTION_QUEUE_CAPTURE ||
  'flux:library:ingestion:capture';

/** @deprecated Use LIBRARY_INGESTION_QUEUE_STANDARD for default routing */
export const LIBRARY_INGESTION_QUEUE =
  process.env.LIBRARY_INGESTION_QUEUE || LIBRARY_INGESTION_QUEUE_STANDARD;

export const LIBRARY_INGESTION_JOB = 'process_ingestion_run';
export const LIBRARY_CAPTURE_JOB = 'process_url_capture';

export type IngestionQueueTier = 'priority' | 'standard' | 'capture';

export function resolveIngestionQueue(tier?: IngestionQueueTier): string {
  switch (tier) {
    case 'priority':
      return LIBRARY_INGESTION_QUEUE_PRIORITY;
    case 'capture':
      return LIBRARY_INGESTION_QUEUE_CAPTURE;
    default:
      return LIBRARY_INGESTION_QUEUE_STANDARD;
  }
}
