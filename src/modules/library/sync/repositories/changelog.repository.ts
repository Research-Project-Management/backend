import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/core';
import { Prisma, LibraryChange, Tombstone } from '@prisma/client';

import {
  AppendChangeEntry,
  AppendChangeInput,
  RecordTombstoneEntry,
  RecordTombstoneInput,
} from '@/modules/library/core/ports/unit-of-work.port';
import { normalizeProjectScopeId } from '@/modules/library/core';

export type { AppendChangeInput, RecordTombstoneInput };

@Injectable()
export class ChangeLogRepository {
  private readonly logger = new Logger(ChangeLogRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  private getClient(tx?: Prisma.TransactionClient) {
    return tx || this.prisma;
  }

  private resolveScope(scope: { userId?: string; projectId?: string | null }) {
    return {
      userId: scope.userId,
      projectId: normalizeProjectScopeId(scope.projectId),
    };
  }

  async allocateNextSequence(
    scope: { userId?: string; projectId?: string | null },
    _tx?: Prisma.TransactionClient,
  ): Promise<bigint> {
    // Note: Always use root client (this.prisma) instead of the interactive transaction.
    // SyncSequence acts as a monotonic sequence generator (analogous to Postgres nextval).
    // Holding the lock on SyncSequence inside an interactive transaction causes severe row-lock
    // contention and P2028 timeouts when multiple items are modified or deleted concurrently.
    const client = this.prisma;
    const { userId, projectId } = this.resolveScope(scope);

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

  async allocateSequenceBatch(
    scope: { userId?: string; projectId?: string | null },
    count: number,
  ): Promise<bigint[]> {
    if (count <= 0) return [];
    const client = this.prisma;
    const { userId, projectId } = this.resolveScope(scope);
    const incrementBy = BigInt(count);

    let endSeq = incrementBy;
    if (projectId) {
      const record = await client.syncSequence.upsert({
        where: { projectId },
        create: {
          projectId,
          currentSequence: incrementBy,
        },
        update: {
          currentSequence: {
            increment: incrementBy,
          },
        },
        select: { currentSequence: true },
      });
      endSeq = record.currentSequence;
    } else if (userId) {
      const record = await client.syncSequence.upsert({
        where: { userId },
        create: {
          userId,
          currentSequence: incrementBy,
        },
        update: {
          currentSequence: {
            increment: incrementBy,
          },
        },
        select: { currentSequence: true },
      });
      endSeq = record.currentSequence;
    }

    const startSeq = endSeq - incrementBy + 1n;
    const sequences: bigint[] = [];
    for (let i = 0n; i < incrementBy; i++) {
      sequences.push(startSeq + i);
    }
    return sequences;
  }

  async appendChange(
    scope: { userId?: string; projectId?: string | null },
    entry: AppendChangeEntry,
    tx?: Prisma.TransactionClient,
  ): Promise<LibraryChange> {
    const client = this.getClient(tx);
    const { userId, projectId } = this.resolveScope(scope);
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
        data: (entry.data as Prisma.InputJsonValue) ?? Prisma.JsonNull,
      },
    });
  }

  async appendChangesBatch(
    entries: AppendChangeInput[],
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    if (!entries || entries.length === 0) return 0;
    const client = this.getClient(tx);

    // Group by scope (projectId or userId) to allocate sequences in 1 query per scope
    const byScope = new Map<
      string,
      {
        scope: { userId?: string; projectId?: string | null };
        items: AppendChangeInput[];
      }
    >();

    for (const entry of entries) {
      const resolved = this.resolveScope({
        userId: entry.userId,
        projectId: entry.projectId,
      });
      const key = resolved.projectId
        ? `proj:${resolved.projectId}`
        : `user:${resolved.userId || ''}`;
      let group = byScope.get(key);
      if (!group) {
        group = { scope: resolved, items: [] };
        byScope.set(key, group);
      }
      group.items.push(entry);
    }

    const createRows: Prisma.LibraryChangeCreateManyInput[] = [];
    for (const group of byScope.values()) {
      const seqs = await this.allocateSequenceBatch(
        group.scope,
        group.items.length,
      );
      group.items.forEach((entry, idx) => {
        createRows.push({
          seq: seqs[idx],
          userId: group.scope.userId || null,
          projectId: group.scope.projectId || null,
          entityType: entry.entityType,
          entityId: entry.entityId,
          action: entry.action,
          version: entry.version,
          data: (entry.data as Prisma.InputJsonValue) ?? Prisma.JsonNull,
        });
      });
    }

    if (typeof client.libraryChange?.createMany === 'function') {
      const res = await client.libraryChange.createMany({
        data: createRows,
      });
      return res.count;
    }

    for (const row of createRows) {
      await client.libraryChange.create({ data: row });
    }
    return createRows.length;
  }

  async recordTombstone(
    scope: { userId?: string; projectId?: string | null },
    entry: RecordTombstoneEntry,
    tx?: Prisma.TransactionClient,
  ): Promise<Tombstone> {
    const client = this.getClient(tx);
    const { userId, projectId } = this.resolveScope(scope);
    const seq = await this.allocateNextSequence(scope, tx);

    const existing = await client.tombstone.findFirst({
      where: {
        userId: userId || null,
        projectId: projectId || null,
        entityType: entry.entityType,
        entityId: entry.entityId,
      },
      select: { id: true },
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

  async recordTombstonesBatch(
    entries: RecordTombstoneInput[],
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    if (!entries || entries.length === 0) return 0;
    const client = this.getClient(tx);

    const byScope = new Map<
      string,
      {
        scope: { userId?: string; projectId?: string | null };
        items: RecordTombstoneInput[];
      }
    >();

    for (const entry of entries) {
      const resolved = this.resolveScope({
        userId: entry.userId,
        projectId: entry.projectId,
      });
      const key = resolved.projectId
        ? `proj:${resolved.projectId}`
        : `user:${resolved.userId || ''}`;
      let group = byScope.get(key);
      if (!group) {
        group = { scope: resolved, items: [] };
        byScope.set(key, group);
      }
      group.items.push(entry);
    }

    let totalRecorded = 0;

    for (const group of byScope.values()) {
      const { userId, projectId } = group.scope;
      const entityIds = Array.from(
        new Set(group.items.map((it) => it.entityId)),
      );

      // Remove any stale tombstones for the same entities in this scope, then bulk-insert fresh tombstones
      if (typeof client.tombstone?.deleteMany === 'function') {
        await client.tombstone.deleteMany({
          where: {
            userId: userId || null,
            projectId: projectId || null,
            entityId: { in: entityIds },
          },
        });
      }

      const seqs = await this.allocateSequenceBatch(
        group.scope,
        group.items.length,
      );
      const deletedAt = new Date();
      const createRows: Prisma.TombstoneCreateManyInput[] = group.items.map(
        (entry, idx) => ({
          userId: userId || null,
          projectId: projectId || null,
          entityType: entry.entityType,
          entityId: entry.entityId,
          seq: seqs[idx],
          deletedAt,
          deletedById: entry.deletedById ?? null,
        }),
      );

      if (typeof client.tombstone?.createMany === 'function') {
        const res = await client.tombstone.createMany({
          data: createRows,
        });
        totalRecorded += res.count;
      } else {
        for (const row of createRows) {
          await client.tombstone.create({ data: row });
        }
        totalRecorded += createRows.length;
      }
    }

    return totalRecorded;
  }

  async compactAndPurgeChangeLog(
    retentionDays: number = 30,
    batchLimit: number = 1000,
  ): Promise<{ purgedChanges: number; purgedTombstones: number }> {
    const cutoff = new Date(Date.now() - retentionDays * 86400 * 1000);

    const oldChanges = await this.prisma.libraryChange.findMany({
      where: { createdAt: { lt: cutoff } },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: batchLimit,
    });

    let purgedChanges = 0;
    if (oldChanges.length > 0) {
      const delRes = await this.prisma.libraryChange.deleteMany({
        where: { id: { in: oldChanges.map((c) => c.id) } },
      });
      purgedChanges = delRes.count;
    }

    const oldTombstones = await this.prisma.tombstone.findMany({
      where: { deletedAt: { lt: cutoff } },
      select: { id: true },
      orderBy: { deletedAt: 'asc' },
      take: batchLimit,
    });

    let purgedTombstones = 0;
    if (oldTombstones.length > 0) {
      const delRes = await this.prisma.tombstone.deleteMany({
        where: { id: { in: oldTombstones.map((t) => t.id) } },
      });
      purgedTombstones = delRes.count;
    }

    return { purgedChanges, purgedTombstones };
  }

  async getChangesSince(
    scope: { userId?: string; projectId?: string | null },
    sinceSeq: bigint | number,
    limit: number = 100,
  ): Promise<LibraryChange[]> {
    const { userId, projectId } = this.resolveScope(scope);
    const seqBigInt =
      typeof sinceSeq === 'bigint' ? sinceSeq : BigInt(sinceSeq);

    return this.prisma.libraryChange.findMany({
      where: {
        ...(projectId ? { projectId } : { userId, projectId: null }),
        seq: {
          gt: seqBigInt,
        },
      },
      orderBy: { seq: 'asc' },
      take: limit,
    });
  }

  async getTombstonesSince(
    scope: { userId?: string; projectId?: string | null },
    sinceSeq?: bigint | number,
    limit: number = 100,
  ): Promise<Tombstone[]> {
    const { userId, projectId } = this.resolveScope(scope);
    const seqBigInt =
      sinceSeq !== undefined
        ? typeof sinceSeq === 'bigint'
          ? sinceSeq
          : BigInt(sinceSeq)
        : undefined;

    return this.prisma.tombstone.findMany({
      where: {
        ...(projectId ? { projectId } : { userId, projectId: null }),
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
    scope: { userId?: string; projectId?: string | null },
  ): Promise<bigint> {
    const { userId, projectId } = this.resolveScope(scope);
    const scopeWhere = projectId ? { projectId } : { userId, projectId: null };

    const [seqRecord, latestChange, latestTombstone] = await Promise.all([
      projectId
        ? this.prisma.syncSequence.findUnique({
            where: { projectId },
            select: { currentSequence: true },
          })
        : userId
          ? this.prisma.syncSequence.findUnique({
              where: { userId },
              select: { currentSequence: true },
            })
          : Promise.resolve(null),
      this.prisma.libraryChange.findFirst({
        where: scopeWhere,
        orderBy: { seq: 'desc' },
        select: { seq: true },
      }),
      this.prisma.tombstone.findFirst({
        where: scopeWhere,
        orderBy: { seq: 'desc' },
        select: { seq: true },
      }),
    ]);

    const seqFromSync = seqRecord?.currentSequence ?? 0n;
    const changeSeq = latestChange?.seq ?? 0n;
    const tombstoneSeq = latestTombstone?.seq ?? 0n;
    const maxCommittedSeq = changeSeq > tombstoneSeq ? changeSeq : tombstoneSeq;

    return maxCommittedSeq > seqFromSync ? maxCommittedSeq : seqFromSync;
  }
}
