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
} from '../repositories/change-log.repository';

export interface TransactionHelpers {
  appendChange(
    workspaceId: string,
    entry: AppendChangeEntry,
  ): Promise<LibraryChange>;
  recordTombstone(
    workspaceId: string,
    entry: RecordTombstoneEntry,
  ): Promise<Tombstone>;
  publishOutbox(
    workspaceId: string,
    aggregateId: string,
    eventType: string,
    payload: any,
  ): Promise<OutboxEvent>;
}

@Injectable()
export class TransactionService {
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
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      const helpers: TransactionHelpers = {
        appendChange: async (workspaceId: string, entry: AppendChangeEntry) => {
          return this.changeLogRepo.appendChange(workspaceId, entry, tx);
        },
        recordTombstone: async (
          workspaceId: string,
          entry: RecordTombstoneEntry,
        ) => {
          return this.changeLogRepo.recordTombstone(workspaceId, entry, tx);
        },
        publishOutbox: async (
          workspaceId: string,
          aggregateId: string,
          eventType: string,
          payload: any,
        ) => {
          return tx.outboxEvent.create({
            data: {
              workspaceId,
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
    });
  }
}
