import { IngestionRunAggregate } from '../model/ingestion-run.aggregate';

export const INGESTION_RUN_REPOSITORY_PORT = Symbol(
  'INGESTION_RUN_REPOSITORY_PORT',
);

export interface IIngestionRunRepositoryPort {
  save(aggregate: IngestionRunAggregate): Promise<void>;
  findById(runId: string): Promise<IngestionRunAggregate | null>;
  findByUserId(
    userId: string,
    limit?: number,
  ): Promise<IngestionRunAggregate[]>;
}
