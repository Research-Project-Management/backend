/**
 * Retraction Repository Port — Processing Domain Layer
 *
 * Application Use Cases call this port to check/sync retraction data.
 * Infrastructure layer implements it using Prisma DB.
 * Zero NestJS or Prisma imports in this file.
 */

export const RETRACTION_REPOSITORY_PORT = Symbol('RETRACTION_REPOSITORY_PORT');

export interface RetractionRecord {
  id: string;
  doi?: string | null;
  pmid?: string | null;
  title?: string | null;
  reason?: string | null;
  retractionDate?: Date | null;
  source: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface RetractionCheckResult {
  isRetracted: boolean;
  record?: RetractionRecord;
}

export interface IRetractionRepositoryPort {
  /**
   * Check if a DOI has been retracted.
   */
  checkByDoi(doi: string): Promise<RetractionCheckResult>;

  /**
   * Check if a PMID (PubMed ID) has been retracted.
   */
  checkByPmid(pmid: string): Promise<RetractionCheckResult>;

  /**
   * Find all retractions seeded in the local database.
   */
  findAll(): Promise<RetractionRecord[]>;

  /**
   * Count total retraction records in the database.
   */
  count(): Promise<number>;

  /**
   * Upsert a retraction record (used by sync service).
   */
  upsert(
    record: Omit<RetractionRecord, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<RetractionRecord>;
}
