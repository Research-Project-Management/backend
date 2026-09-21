import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../../../core/database/prisma.service';
import { Prisma, LibraryChange, Tombstone } from '@prisma/client';

export interface AppendChangeEntry {
  entityType: string;
  entityId: string;
  action: 'create' | 'update' | 'delete';
  version: number;
  data?: any;
}

export interface RecordTombstoneEntry {
  entityType: string;
  entityId: string;
  deletedById?: string;
}

@Injectable()
export class ChangeLogRepository {
  private readonly logger = new Logger(ChangeLogRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  private getClient(tx?: Prisma.TransactionClient) {
    return tx || this.prisma;
  }

  async allocateNextSequence(
    scope: { userId?: string; projectId?: string } | string,
    _tx?: Prisma.TransactionClient,
  ): Promise<bigint> {
    // Note: Always use root client (this.prisma) instead of the interactive transaction.
    // SyncSequence acts as a monotonic sequence generator (analogous to Postgres nextval).
    // Holding the lock on SyncSequence inside an interactive transaction causes severe row-lock
    // contention and P2028 timeouts when multiple items are modified or deleted concurrently.
    const client = this.prisma;
    const userId = typeof scope === 'object' ? scope.userId : scope;
    const projectId = typeof scope === 'object' ? scope.projectId : undefined;

    if (projectId) {
      const record = await client.syncSequence.upsert({
        where: { projectId },
        create: {
          projectId,
          currentSequence: BigInt(1),
        },
        update: {
          currentSequence: {
            increment: BigInt(1),
          },
        },
        select: { currentSequence: true },
      });
      return record.currentSequence;
    }

    if (userId) {
      const record = await client.syncSequence.upsert({
        where: { userId },
        create: {
          userId,
          currentSequence: BigInt(1),
        },
        update: {
          currentSequence: {
            increment: BigInt(1),
          },
        },
        select: { currentSequence: true },
      });
      return record.currentSequence;
    }

    return BigInt(1);
  }

  async appendChange(
    scope: { userId?: string; projectId?: string } | string,
    entry: AppendChangeEntry,
    tx?: Prisma.TransactionClient,
  ): Promise<LibraryChange> {
    const client = this.getClient(tx);
    const userId = typeof scope === 'object' ? scope.userId : scope;
    const projectId = typeof scope === 'object' ? scope.projectId : undefined;
    const seq = await this.allocateNextSequence(scope, tx);

    return client.libraryChange.create({
      data: {
        seq,
        userId: userId || null,
        projectId: projectId || null,
        entityType: entry.entityType,
        entityId: entry.entityId,
        action: entry.action,
        version: entry.version,
        data: entry.data ?? null,
      },
    });
  }

  async recordTombstone(
    scope: { userId?: string; projectId?: string } | string,
    entry: RecordTombstoneEntry,
    tx?: Prisma.TransactionClient,
  ): Promise<Tombstone> {
    const client = this.getClient(tx);
    const userId = typeof scope === 'object' ? scope.userId : scope;
    const projectId = typeof scope === 'object' ? scope.projectId : undefined;
    const seq = await this.allocateNextSequence(scope, tx);

    const existing = await client.tombstone.findFirst({
      where: {
        userId: userId || null,
        projectId: projectId || null,
        entityType: entry.entityType,
        entityId: entry.entityId,
      },
    });

    if (existing) {
      return client.tombstone.update({
        where: { id: existing.id },
        data: {
          seq,
          deletedAt: new Date(),
          deletedById: entry.deletedById ?? null,
        },
      });
    }

    return client.tombstone.create({
      data: {
        userId: userId || null,
        projectId: projectId || null,
        entityType: entry.entityType,
        entityId: entry.entityId,
        seq,
        deletedById: entry.deletedById ?? null,
      },
    });
  }

  async getChangesSince(
    scope: { userId?: string; projectId?: string } | string,
    sinceSeq: bigint | number,
    limit: number = 100,
  ): Promise<LibraryChange[]> {
    const userId = typeof scope === 'object' ? scope.userId : scope;
    const projectId = typeof scope === 'object' ? scope.projectId : undefined;
    const seqBigInt =
      typeof sinceSeq === 'bigint' ? sinceSeq : BigInt(sinceSeq);

    return this.prisma.libraryChange.findMany({
      where: {
        ...(projectId ? { projectId } : { userId }),
        seq: {
          gt: seqBigInt,
        },
      },
      orderBy: { seq: 'asc' },
      take: limit,
    });
  }

  async getTombstonesSince(
    scope: { userId?: string; projectId?: string } | string,
    sinceSeq?: bigint | number,
    limit: number = 100,
  ): Promise<Tombstone[]> {
    const userId = typeof scope === 'object' ? scope.userId : scope;
    const projectId = typeof scope === 'object' ? scope.projectId : undefined;
    const seqBigInt =
      sinceSeq !== undefined
        ? typeof sinceSeq === 'bigint'
          ? sinceSeq
          : BigInt(sinceSeq)
        : undefined;

    return this.prisma.tombstone.findMany({
      where: {
        ...(projectId ? { projectId } : { userId }),
        ...(seqBigInt !== undefined
          ? {
              seq: {
                gt: seqBigInt,
              },
            }
          : {}),
      },
      orderBy: { seq: 'asc' },
      take: limit,
    });
  }

  async getLatestSequence(
    scope: { userId?: string; projectId?: string } | string,
  ): Promise<bigint> {
    const userId = typeof scope === 'object' ? scope.userId : scope;
    const projectId = typeof scope === 'object' ? scope.projectId : undefined;

    if (projectId) {
      const seq = await this.prisma.syncSequence.findUnique({
        where: { projectId },
        select: { currentSequence: true },
      });
      return seq?.currentSequence ?? BigInt(0);
    }

    if (userId) {
      const seq = await this.prisma.syncSequence.findUnique({
        where: { userId },
        select: { currentSequence: true },
      });
      return seq?.currentSequence ?? BigInt(0);
    }

    return BigInt(0);
  }

  /**
   * Purges historical library_changes older than `olderThanMs` (default 90 days).
   * Compacts the changelog to avoid unbounded growth while preserving tombstones.
   */
  async purgeOldChanges(
    olderThanMs: number = 90 * 24 * 60 * 60 * 1000,
  ): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const result = await this.prisma.libraryChange.deleteMany({
      where: {
        createdAt: { lte: cutoff },
      },
    });
    if (result.count > 0) {
      this.logger.log(
        `Purged ${result.count} historical library changes older than ${cutoff.toISOString()}`,
      );
    }
    return result.count;
  }
}
