import { Injectable, Inject, Logger } from '@nestjs/common';
import {
  INGESTION_RUN_REPOSITORY_PORT,
  IIngestionRunRepositoryPort,
} from '../../domain/ports/ingestion-run-repository.port';
import { IngestionRunResultDto } from '../commands/start-ingestion-run.use-case';

@Injectable()
export class GetIngestionRunUseCase {
  private readonly logger = new Logger(GetIngestionRunUseCase.name);

  constructor(
    @Inject(INGESTION_RUN_REPOSITORY_PORT)
    private readonly repo: IIngestionRunRepositoryPort,
  ) {}

  async execute(runId: string): Promise<IngestionRunResultDto | null> {
    const aggregate = await this.repo.findById(runId);
    if (!aggregate) return null;

    return {
      id: aggregate.id,
      userId: aggregate.userId,
      projectId: aggregate.projectId,
      sourceType: aggregate.sourceType,
      status: aggregate.status,
      totalItems: aggregate.totalItems,
      processedItems: aggregate.processedItems,
      failedItems: aggregate.failedItems,
      startedAt: aggregate.startedAt,
      completedAt: aggregate.completedAt,
    };
  }
}
