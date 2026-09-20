import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../../core/database/prisma.service';
import {
  Prisma,
  LibraryChange,
  Tombstone,
  OutboxEvent,
  OutboxStatus,
} from '@prisma/client';
import {
  ChangeLogRepository,
  AppendChangeEntry,
  RecordTombstoneEntry,
} from './repositories/changelog.repository';
import { IUnitOfWork } from './ports/unit-of-work.port';

export interface TransactionHelpers {
  appendChange(
    scope: { userId?: string; projectId?: string } | string,
    entry: AppendChangeEntry,
  ): Promise<LibraryChange>;
  recordTombstone(
    scope: { userId?: string; projectId?: string } | string,
    entry: RecordTombstoneEntry,
  ): Promise<Tombstone>;
  publishOutbox(
    scope: { userId: string; projectId?: string | null } | string,
    aggregateId: string,
    eventType: string,
    payload: any,
  ): Promise<OutboxEvent>;
}

@Injectable()
export class TransactionService implements IUnitOfWork {
  private readonly logger = new Logger(TransactionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly changeLogRepo: ChangeLogRepository,
  ) {}

  async executeInTransaction<T>(
    operation: (
      tx: Prisma.TransactionClient,
      helpers: TransactionHelpers,
    ) => Promise<T>,
    options?: { maxWait?: number; timeout?: number },
  ): Promise<T> {
    return this.prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        const helpers: TransactionHelpers = {
          appendChange: async (
            scope: { userId?: string; projectId?: string } | string,
            entry: AppendChangeEntry,
          ) => {
            return this.changeLogRepo.appendChange(scope, entry, tx);
          },
          recordTombstone: async (
            scope: { userId?: string; projectId?: string } | string,
            entry: RecordTombstoneEntry,
          ) => {
            return this.changeLogRepo.recordTombstone(scope, entry, tx);
          },
          publishOutbox: async (
            scope: { userId: string; projectId?: string | null } | string,
            aggregateId: string,
            eventType: string,
            payload: any,
          ) => {
            const userId = typeof scope === 'object' ? scope.userId : scope;
            const projectId =
              typeof scope === 'object' ? scope.projectId : undefined;

            return tx.outboxEvent.create({
              data: {
                userId,
                projectId: projectId || null,
                aggregateId,
                eventType,
                payload: payload ?? {},
                status: OutboxStatus.PENDING,
                retryCount: 0,
              },
            });
          },
        };

        return operation(tx, helpers);
      },
      {
        maxWait: options?.maxWait ?? 10000,
        timeout: options?.timeout ?? 30000,
      },
    );
  }

  async getChangesSince(
    scope: { userId?: string; projectId?: string } | string,
    sinceSeq: bigint = BigInt(0),
    limit: number = 100,
  ): Promise<LibraryChange[]> {
    return this.changeLogRepo.getChangesSince(scope, sinceSeq, limit);
  }

  async getTombstonesSince(
    scope: { userId?: string; projectId?: string } | string,
    sinceSeq?: bigint,
    limit: number = 100,
  ): Promise<Tombstone[]> {
    return this.changeLogRepo.getTombstonesSince(scope, sinceSeq, limit);
  }

  async getLatestSequence(
    scope: { userId?: string; projectId?: string } | string,
  ) {
    return this.changeLogRepo.getLatestSequence(scope);
  }
}
