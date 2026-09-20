import { Injectable, Inject, Logger } from '@nestjs/common';
import { IngestionRunAggregate } from '../../domain/model/ingestion-run.aggregate';
import {
  INGESTION_RUN_REPOSITORY_PORT,
  IIngestionRunRepositoryPort,
} from '../../domain/ports/ingestion-run-repository.port';

export interface StartIngestionRunCommand {
  userId: string;
  sourceType: string;
  projectId?: string | null;
  totalItems?: number;
}

export interface IngestionRunResultDto {
  id: string;
  userId: string;
  projectId?: string | null;
  sourceType: string;
  status: string;
  totalItems: number;
  processedItems: number;
  failedItems: number;
  startedAt: Date;
  completedAt?: Date | null;
}

@Injectable()
export class StartIngestionRunUseCase {
  private readonly logger = new Logger(StartIngestionRunUseCase.name);

  constructor(
    @Inject(INGESTION_RUN_REPOSITORY_PORT)
    private readonly repo: IIngestionRunRepositoryPort,
  ) {}

  async execute(
    command: StartIngestionRunCommand,
  ): Promise<IngestionRunResultDto> {
    this.logger.debug(`Starting ingestion run for user ${command.userId}`);

    const aggregate = IngestionRunAggregate.create({
      userId: command.userId,
      projectId: command.projectId,
      sourceType: command.sourceType,
      totalItems: command.totalItems,
    });

    await this.repo.save(aggregate);

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
