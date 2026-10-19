/**
 * Ingestion Queue Constants
 */
import { libraryConfig } from '../../core/config/library.config';

export const LIBRARY_INGESTION_QUEUE_STANDARD =
  libraryConfig().ingestion.standardQueue;

export const LIBRARY_INGESTION_QUEUE = LIBRARY_INGESTION_QUEUE_STANDARD;

export const LIBRARY_INGESTION_JOB = 'process_ingestion_run';

