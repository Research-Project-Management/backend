import { Injectable, Logger } from '@nestjs/common';
import { IIngestionRunRepositoryPort } from '../../domain/ports/ingestion-run-repository.port';
import { IngestionRunAggregate } from '../../domain/model/ingestion-run.aggregate';
import { PrismaService } from '../../../../../core/database/prisma.service';
import { IngestionStatus } from '@prisma/client';

/**
 * Infrastructure Adapter implementing IIngestionRunRepositoryPort using Prisma.
 */
@Injectable()
export class PrismaIngestionRunRepositoryAdapter implements IIngestionRunRepositoryPort {
  private readonly logger = new Logger(
    PrismaIngestionRunRepositoryAdapter.name,
  );

  constructor(private readonly prisma: PrismaService) {}

  async findById(runId: string): Promise<IngestionRunAggregate | null> {
    const raw = await this.prisma.ingestionRun.findUnique({
      where: { id: runId },
    });

    if (!raw) return null;

    return IngestionRunAggregate.reconstitute({
      id: raw.id,
      userId: raw.userId,
      projectId: raw.projectId,
      sourceType: (raw.inputParams as any)?.sourceType || 'manual',
      status: this.mapPrismaStatusToDomain(raw.status),
      totalItems: (raw.inputParams as any)?.totalItems || 1,
      processedItems: raw.status === IngestionStatus.READY ? 1 : 0,
      failedItems: raw.status === IngestionStatus.FAILED_FINAL ? 1 : 0,
      errorReason: raw.lastError,
      startedAt: raw.startedAt,
      completedAt: raw.completedAt,
    });
  }

  async findByUserId(
    userId: string,
    limit = 20,
  ): Promise<IngestionRunAggregate[]> {
    const records = await this.prisma.ingestionRun.findMany({
      where: { userId },
      orderBy: { startedAt: 'desc' },
      take: limit,
    });

    return records.map((raw) =>
      IngestionRunAggregate.reconstitute({
        id: raw.id,
        userId: raw.userId,
        projectId: raw.projectId,
        sourceType: (raw.inputParams as any)?.sourceType || 'manual',
        status: this.mapPrismaStatusToDomain(raw.status),
        totalItems: (raw.inputParams as any)?.totalItems || 1,
        processedItems: raw.status === IngestionStatus.READY ? 1 : 0,
        failedItems: raw.status === IngestionStatus.FAILED_FINAL ? 1 : 0,
        errorReason: raw.lastError,
        startedAt: raw.startedAt,
        completedAt: raw.completedAt,
      }),
    );
  }

  async save(aggregate: IngestionRunAggregate): Promise<void> {
    const prismaStatus = this.mapDomainStatusToPrisma(aggregate.status);

    await this.prisma.ingestionRun.upsert({
      where: { id: aggregate.id },
      create: {
        id: aggregate.id,
        userId: aggregate.userId,
        projectId: aggregate.projectId ?? null,
        status: prismaStatus,
        inputHash: crypto.randomUUID(),
        inputParams: {
          sourceType: aggregate.sourceType,
          totalItems: aggregate.totalItems,
        },
        lastError: aggregate.errorReason ?? null,
        startedAt: aggregate.startedAt,
        completedAt: aggregate.completedAt ?? null,
      },
      update: {
        status: prismaStatus,
        lastError: aggregate.errorReason ?? null,
        completedAt: aggregate.completedAt ?? null,
      },
    });
  }

  private mapPrismaStatusToDomain(status: IngestionStatus): string {
    switch (status) {
      case IngestionStatus.READY:
      case IngestionStatus.COMMITTED:
        return 'COMPLETED';
      case IngestionStatus.FAILED_FINAL:
      case IngestionStatus.FAILED_RETRYABLE:
        return 'FAILED';
      default:
        return 'RUNNING';
    }
  }

  private mapDomainStatusToPrisma(status: string): IngestionStatus {
    switch (status) {
      case 'COMPLETED':
        return IngestionStatus.READY;
      case 'FAILED':
        return IngestionStatus.FAILED_FINAL;
      case 'RUNNING':
        return IngestionStatus.DETECTED;
      default:
        return IngestionStatus.RECEIVED;
    }
  }
}
