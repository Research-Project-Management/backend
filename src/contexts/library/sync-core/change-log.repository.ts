import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../core/database/prisma.service';
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
  private readonly memSeqs = new Map<string, bigint>();
  private readonly memChanges = new Map<string, LibraryChange[]>();
  private readonly memTombstones = new Map<string, Tombstone[]>();

  constructor(private readonly prisma: PrismaService) {}

  private getClient(tx?: Prisma.TransactionClient) {
    return tx || this.prisma;
  }

  async allocateNextSequence(
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<bigint> {
    const client = this.getClient(tx);

    try {
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
    } catch {
      // In-memory fallback if table does not exist in DB yet
      const cur = this.memSeqs.get(workspaceId) ?? BigInt(0);
      const next = cur + BigInt(1);
      this.memSeqs.set(workspaceId, next);
      return next;
    }
  }

  async appendChange(
    workspaceId: string,
    entry: AppendChangeEntry,
    tx?: Prisma.TransactionClient,
  ): Promise<LibraryChange> {
    const client = this.getClient(tx);
    const seq = await this.allocateNextSequence(workspaceId, tx);

    try {
      return await client.libraryChange.create({
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
    } catch {
      const change: LibraryChange = {
        seq,
        workspaceId,
        entityType: entry.entityType,
        entityId: entry.entityId,
        action: entry.action,
        version: entry.version,
        timestamp: new Date(),
        data: entry.data ?? null,
      };

      const list = this.memChanges.get(workspaceId) ?? [];
      list.push(change);
      this.memChanges.set(workspaceId, list);

      return change;
    }
  }

  async recordTombstone(
    workspaceId: string,
    entry: RecordTombstoneEntry,
    tx?: Prisma.TransactionClient,
  ): Promise<Tombstone> {
    const client = this.getClient(tx);
    const seq = await this.allocateNextSequence(workspaceId, tx);

    try {
      return await client.tombstone.upsert({
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
    } catch {
      const tombstone: Tombstone = {
        id: `tomb-${entry.entityType}-${entry.entityId}`,
        workspaceId,
        entityType: entry.entityType,
        entityId: entry.entityId,
        seq,
        deletedAt: new Date(),
        deletedById: entry.deletedById ?? null,
      };

      const list = this.memTombstones.get(workspaceId) ?? [];
      list.push(tombstone);
      this.memTombstones.set(workspaceId, list);

      return tombstone;
    }
  }

  async getChangesSince(
    workspaceId: string,
    sinceSeq: bigint | number,
    limit: number = 100,
  ): Promise<LibraryChange[]> {
    const seqBigInt =
      typeof sinceSeq === 'bigint' ? sinceSeq : BigInt(sinceSeq);

    try {
      return await this.prisma.libraryChange.findMany({
        where: {
          workspaceId,
          seq: {
            gt: seqBigInt,
          },
        },
        orderBy: { seq: 'asc' },
        take: limit,
      });
    } catch {
      const list = this.memChanges.get(workspaceId) ?? [];
      return list.filter((c) => c.seq > seqBigInt).slice(0, limit);
    }
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

    try {
      return await this.prisma.tombstone.findMany({
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
    } catch {
      const list = this.memTombstones.get(workspaceId) ?? [];
      return seqBigInt !== undefined
        ? list.filter((t) => t.seq != null && t.seq > seqBigInt).slice(0, limit)
        : list.slice(0, limit);
    }
  }

  async getLatestSequence(workspaceId: string): Promise<bigint> {
    try {
      const seq = await this.prisma.syncSequence.findUnique({
        where: { workspaceId },
        select: { currentSequence: true },
      });

      if (seq?.currentSequence !== undefined) {
        return seq.currentSequence;
      }
    } catch {
      // Fallback
    }

    return this.memSeqs.get(workspaceId) ?? BigInt(0);
  }
}
