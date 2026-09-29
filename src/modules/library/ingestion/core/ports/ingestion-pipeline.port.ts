/**
 * Ingestion Pipeline Port — Processing Domain Layer
 *
 * Application layer calls this port to trigger the ingestion pipeline.
 * Infrastructure layer implements it (wrapping the existing pipeline services).
 * Zero NestJS or Prisma imports in this file.
 */

export const INGESTION_PIPELINE_PORT = Symbol('INGESTION_PIPELINE_PORT');

export type IngestionSource =
  'doi' | 'url' | 'bibtex' | 'ris' | 'manual' | 'file';

export interface IngestionSubmission {
  userId: string;
  projectId?: string | null;
  source: IngestionSource;
  /** Raw input: DOI string, URL, BibTeX text, RIS text, or manual metadata */
  payload: string | Record<string, unknown>;
  idempotencyKey?: string;
}

export interface IngestionResult {
  runId: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  itemId?: string;
  error?: string;
}

export interface IIngestionPipelinePort {
  /**
   * Submit a new ingestion job to the pipeline.
   * Returns a run ID for tracking progress via GetIngestionRunUseCase.
   */
  submit(submission: IngestionSubmission): Promise<IngestionResult>;

  /**
   * Check the current status of an ingestion run.
   */
  getStatus(runId: string): Promise<IngestionResult | null>;
}
