import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../../core/database/prisma.service';
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
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<bigint> {
    const client = this.getClient(tx);

    const record = await client.syncSequence.upsert({
      where: { workspaceId },
      create: {
        workspaceId,
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

  async appendChange(
    workspaceId: string,
    entry: AppendChangeEntry,
    tx?: Prisma.TransactionClient,
  ): Promise<LibraryChange> {
    const client = this.getClient(tx);
    const seq = await this.allocateNextSequence(workspaceId, tx);

    return client.libraryChange.create({
      data: {
        seq,
        workspaceId,
        entityType: entry.entityType,
        entityId: entry.entityId,
        action: entry.action,
        version: entry.version,
        data: entry.data ?? null,
      },
    });
  }

  async recordTombstone(
    workspaceId: string,
    entry: RecordTombstoneEntry,
    tx?: Prisma.TransactionClient,
  ): Promise<Tombstone> {
    const client = this.getClient(tx);
    const seq = await this.allocateNextSequence(workspaceId, tx);

    return client.tombstone.upsert({
      where: {
        workspaceId_entityType_entityId: {
          workspaceId,
          entityType: entry.entityType,
          entityId: entry.entityId,
        },
      },
      create: {
        workspaceId,
        entityType: entry.entityType,
        entityId: entry.entityId,
        seq,
        deletedById: entry.deletedById ?? null,
      },
      update: {
        seq,
        deletedAt: new Date(),
        deletedById: entry.deletedById ?? null,
      },
    });
  }

  async getChangesSince(
    workspaceId: string,
    sinceSeq: bigint | number,
    limit: number = 100,
  ): Promise<LibraryChange[]> {
    const seqBigInt =
      typeof sinceSeq === 'bigint' ? sinceSeq : BigInt(sinceSeq);

    return this.prisma.libraryChange.findMany({
      where: {
        workspaceId,
        seq: {
          gt: seqBigInt,
        },
      },
      orderBy: { seq: 'asc' },
      take: limit,
    });
  }

  async getTombstonesSince(
    workspaceId: string,
    sinceSeq?: bigint | number,
    limit: number = 100,
  ): Promise<Tombstone[]> {
    const seqBigInt =
      sinceSeq !== undefined
        ? typeof sinceSeq === 'bigint'
          ? sinceSeq
          : BigInt(sinceSeq)
        : undefined;

    return this.prisma.tombstone.findMany({
      where: {
        workspaceId,
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

  async getLatestSequence(workspaceId: string): Promise<bigint> {
    const seq = await this.prisma.syncSequence.findUnique({
      where: { workspaceId },
      select: { currentSequence: true },
    });

    return seq?.currentSequence ?? BigInt(0);
  }
}
