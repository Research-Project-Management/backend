import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
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
      processedItems: raw.status === IngestionStatus.COMPLETED ? 1 : 0,
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
        processedItems: raw.status === IngestionStatus.COMPLETED ? 1 : 0,
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
        inputHash: randomUUID(),
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
    return status as string;
  }

  private mapDomainStatusToPrisma(status: string): IngestionStatus {
    const upper = status.toUpperCase();
    if (upper === 'COMPLETED' || upper === 'READY') return IngestionStatus.COMPLETED;
    if (upper === 'FAILED' || upper === 'FAILED_FINAL') return IngestionStatus.FAILED_FINAL;
    if (upper === 'FAILED_RETRYABLE') return IngestionStatus.FAILED_RETRYABLE;
    if (upper === 'NEEDS_REVIEW') return IngestionStatus.COMPLETED;
    if (upper === 'RUNNING') return IngestionStatus.RUNNING;
    if (upper === 'CANCELLED') return IngestionStatus.CANCELLED;
    if (upper === 'STALLED') return IngestionStatus.STALLED;
    return IngestionStatus.PENDING;
  }
}
