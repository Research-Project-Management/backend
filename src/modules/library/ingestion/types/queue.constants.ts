/**
 * Ingestion Queue Constants
 *
 * Priority-based queue routing:
 * - PRIORITY queue: Premium users, immediate batch imports, retries (concurrency: 8)
 * - STANDARD queue: Free-tier users, background sync (concurrency: 4)
 * - CAPTURE queue: URL capture jobs, isolated from pipeline (concurrency: 4)
 */
import { libraryConfig } from '../../core/config/library.config';

export const LIBRARY_INGESTION_QUEUE_PRIORITY =
  libraryConfig().ingestion.priorityQueue;

export const LIBRARY_INGESTION_QUEUE_STANDARD =
  libraryConfig().ingestion.standardQueue;

export const LIBRARY_INGESTION_QUEUE_CAPTURE =
  libraryConfig().ingestion.captureQueue;

export const LIBRARY_INGESTION_QUEUE = LIBRARY_INGESTION_QUEUE_STANDARD;

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
