import {
  Injectable,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '@/core';
import { Prisma, LibraryChange, Tombstone } from '@prisma/client';
import {
  AppendChangeEntry,
  AppendChangeInput,
  RecordTombstoneEntry,
  RecordTombstoneInput,
  normalizeProjectScopeId,
} from '@/modules/library/core';

export type { AppendChangeInput, RecordTombstoneInput };

@Injectable()
export class ChangeLogRepository {
  private readonly logger = new Logger(ChangeLogRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  private getClient(tx?: Prisma.TransactionClient) {
    return tx || this.prisma;
  }

  private resolveScope(
    scope: { userId?: string; projectId?: string | null } | string,
  ): {
    userId?: string;
    projectId?: string;
    scopeKey: string;
  } {
    if (typeof scope === 'string') {
      const trimmed = scope.trim();
      if (trimmed.startsWith('proj:')) {
        const projectId = trimmed.slice(5).trim();
        if (!projectId) {
          throw new BadRequestException('Invalid project sync scope');
        }
        return { userId: undefined, projectId, scopeKey: `proj:${projectId}` };
      }
      if (trimmed.startsWith('user:')) {
        const userId = trimmed.slice(5).trim();
        if (!userId) {
          throw new BadRequestException('Invalid user sync scope');
        }
        return { userId, projectId: undefined, scopeKey: `user:${userId}` };
      }
      if (!trimmed) {
        throw new BadRequestException('Sync scope must not be empty');
      }
      return {
        userId: trimmed,
        projectId: undefined,
        scopeKey: `user:${trimmed}`,
      };
    }

    const projectId = normalizeProjectScopeId(scope.projectId);
    const userId = scope.userId?.trim() || undefined;
    if (projectId) {
      return { userId, projectId, scopeKey: `proj:${projectId}` };
    }
    if (userId) {
      return { userId, projectId: undefined, scopeKey: `user:${userId}` };
    }
    throw new BadRequestException(
      'Sync scope must include either a valid userId or projectId',
    );
  }

  private buildScopeWhere(
    userId?: string,
    projectId?: string | null,
  ): { userId?: string | null; projectId: string | null } {
    return projectId
      ? { projectId }
      : { userId: userId || null, projectId: null };
  }

  private resolveActorId(
    userId?: string | null,
    explicitActorId?: string | null,
  ): string | null {
    const candidate = (explicitActorId ?? userId ?? '').trim();
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      candidate,
    ) && candidate !== '00000000-0000-0000-0000-000000000000'
      ? candidate
      : null;
  }

  async allocateNextSequence(
    scope: { userId?: string; projectId?: string | null } | string,
    countOrTx: number | Prisma.TransactionClient = 1,
    tx?: Prisma.TransactionClient,
  ): Promise<bigint> {
    const count = typeof countOrTx === 'number' ? countOrTx : 1;
    const client =
      (typeof countOrTx !== 'number' ? countOrTx : tx) || this.prisma;
    const { userId, projectId, scopeKey } = this.resolveScope(scope);
    const incrementBy = BigInt(count);

    if (projectId) {
      const record = await client.syncSequence.upsert({
        where: { projectId },
        create: { scopeKey, projectId, currentSequence: incrementBy },
        update: { scopeKey, currentSequence: { increment: incrementBy } },
        select: { currentSequence: true },
      });
      return record.currentSequence;
    }
    if (userId) {
      const record = await client.syncSequence.upsert({
        where: { userId },
        create: { scopeKey, userId, currentSequence: incrementBy },
        update: { scopeKey, currentSequence: { increment: incrementBy } },
        select: { currentSequence: true },
      });
      return record.currentSequence;
    }
    throw new BadRequestException(
      'Sync scope must include either a valid userId or projectId',
    );
  }

  async allocateSequenceBatch(
    scope: { userId?: string; projectId?: string | null } | string,
    count: number,
    tx?: Prisma.TransactionClient,
  ): Promise<bigint[]> {
    if (count <= 0) return [];
    const endSeq = await this.allocateNextSequence(scope, count, tx);
    const incrementBy = BigInt(count);
    const startSeq = endSeq - incrementBy + 1n;
    const sequences: bigint[] = [];
    for (let i = 0n; i < incrementBy; i++) sequences.push(startSeq + i);
    return sequences;
  }

  async appendChange(
    scope: { userId?: string; projectId?: string | null },
    entry: AppendChangeEntry,
    tx?: Prisma.TransactionClient,
  ): Promise<LibraryChange> {
    const client = this.getClient(tx);
    const { userId, projectId, scopeKey } = this.resolveScope(scope);

    // Strictly append-only CDC: every mutation (including repeated delete/restore/delete cycles)
    // allocates a fresh sequence number and inserts a new immutable LibraryChange row.
    const seq = await this.allocateNextSequence(scope, 1, tx);
    const actorId = this.resolveActorId(userId, entry.actorId);

    return client.libraryChange.create({
      data: {
        scopeKey,
        seq,
        userId: userId || null,
        actorId,
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

    const byScope = new Map<
      string,
      {
        scope: { userId?: string; projectId?: string; scopeKey: string };
        items: AppendChangeInput[];
      }
    >();
    for (const entry of entries) {
      const resolved = this.resolveScope({
        userId: entry.userId,
        projectId: entry.projectId,
      });
      let group = byScope.get(resolved.scopeKey);
      if (!group) {
        group = { scope: resolved, items: [] };
        byScope.set(resolved.scopeKey, group);
      }
      group.items.push(entry);
    }

    const createRows: Prisma.LibraryChangeCreateManyInput[] = [];

    for (const group of byScope.values()) {
      const { scopeKey } = group.scope;
      const seqs = await this.allocateSequenceBatch(
        group.scope,
        group.items.length,
        tx,
      );
      group.items.forEach((entry, idx) => {
        const effectiveUserId = entry.userId || group.scope.userId || null;
        createRows.push({
          scopeKey,
          seq: seqs[idx],
          userId: effectiveUserId,
          actorId: this.resolveActorId(effectiveUserId, entry.actorId),
          projectId: group.scope.projectId || null,
          entityType: entry.entityType,
          entityId: entry.entityId,
          action: entry.action,
          version: entry.version,
          data: (entry.data as Prisma.InputJsonValue) ?? Prisma.JsonNull,
        });
      });
    }

    if (createRows.length === 0) return 0;
    if (client.libraryChange?.createMany) {
      const res = await client.libraryChange.createMany({ data: createRows });
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
    const { userId, projectId, scopeKey } = this.resolveScope(scope);
    const scopeWhere = this.buildScopeWhere(userId, projectId);

    // Check if a 'delete' LibraryChange was already recorded for this entity in the same transaction
    // and is still the latest change (no newer create/update occurred since).
    let existingDeleteChange: {
      id: string;
      seq: bigint;
      data?: unknown;
    } | null = null;
    if (client.libraryChange?.findFirst) {
      const candidate = await client.libraryChange.findFirst({
        where: {
          ...scopeWhere,
          entityType: entry.entityType,
          entityId: entry.entityId,
          action: 'delete',
        },
        orderBy: { seq: 'desc' },
        select: { id: true, seq: true, data: true },
      });
      if (candidate) {
        const newerChange = await client.libraryChange.findFirst({
          where: {
            ...scopeWhere,
            entityType: entry.entityType,
            entityId: entry.entityId,
            seq: { gt: candidate.seq },
          },
          select: { id: true },
        });
        if (!newerChange) {
          existingDeleteChange = candidate;
        }
      }
    }

    const seq =
      existingDeleteChange?.seq ??
      (await this.allocateNextSequence(scope, 1, tx));
    const effectiveDeletedById = this.resolveActorId(
      userId,
      entry.deletedById ?? entry.actorId,
    );

    if (!existingDeleteChange && client.libraryChange?.create) {
      await client.libraryChange.create({
        data: {
          scopeKey,
          seq,
          userId: userId || null,
          actorId: effectiveDeletedById,
          projectId: projectId || null,
          entityType: entry.entityType,
          entityId: entry.entityId,
          action: 'delete',
          version: 0,
          data: Prisma.DbNull,
        },
      });
    }

    const deletedAt = new Date();
    const deletedById = entry.deletedById ?? effectiveDeletedById;

    if (typeof client.tombstone?.upsert === 'function') {
      return client.tombstone.upsert({
        where: {
          scopeKey_entityType_entityId: {
            scopeKey,
            entityType: entry.entityType,
            entityId: entry.entityId,
          },
        },
        create: {
          scopeKey,
          userId: userId || null,
          projectId: projectId || null,
          entityType: entry.entityType,
          entityId: entry.entityId,
          seq,
          deletedAt,
          deletedById,
        },
        update: {
          seq,
          deletedAt,
          deletedById,
        },
      });
    }

    const existing = await client.tombstone.findFirst({
      where: {
        ...scopeWhere,
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
          deletedAt,
          deletedById,
        },
      });
    }

    return client.tombstone.create({
      data: {
        scopeKey,
        userId: userId || null,
        projectId: projectId || null,
        entityType: entry.entityType,
        entityId: entry.entityId,
        seq,
        deletedAt,
        deletedById,
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
        scope: { userId?: string; projectId?: string; scopeKey: string };
        items: RecordTombstoneInput[];
      }
    >();

    for (const entry of entries) {
      const resolved = this.resolveScope({
        userId: entry.userId,
        projectId: entry.projectId,
      });
      let group = byScope.get(resolved.scopeKey);
      if (!group) {
        group = { scope: resolved, items: [] };
        byScope.set(resolved.scopeKey, group);
      }
      group.items.push(entry);
    }

    let totalRecorded = 0;

    for (const group of byScope.values()) {
      const { userId, projectId, scopeKey } = group.scope;
      const scopeWhere = this.buildScopeWhere(userId, projectId);
      const entityIds = Array.from(
        new Set(group.items.map((it) => it.entityId)),
      );
      const entityTypes = Array.from(
        new Set(group.items.map((it) => it.entityType)),
      );

      if (client.tombstone?.deleteMany) {
        await client.tombstone.deleteMany({
          where: {
            ...scopeWhere,
            entityType:
              entityTypes.length === 1
                ? entityTypes[0]
                : { in: entityTypes },
            entityId: { in: entityIds },
          },
        });
      }

      const existingDeleteSeqByKey = new Map<string, bigint>();
      const batchCutoffMs = Date.now() - 2000;
      if (client.libraryChange?.findMany) {
        const existingChanges = await client.libraryChange.findMany({
          where: {
            ...scopeWhere,
            entityType:
              entityTypes.length === 1
                ? entityTypes[0]
                : { in: entityTypes },
            entityId: { in: entityIds },
          },
          orderBy: { seq: 'desc' },
          select: {
            entityType: true,
            entityId: true,
            action: true,
            seq: true,
            createdAt: true,
          },
        });
        const seenKeys = new Set<string>();
        for (const ch of existingChanges) {
          const k = `${ch.entityType}:${ch.entityId}`;
          if (!seenKeys.has(k)) {
            seenKeys.add(k);
            const isRecentBatchDelete =
              ch.action === 'delete' &&
              (!ch.createdAt ||
                new Date(ch.createdAt).getTime() >= batchCutoffMs);
            if (isRecentBatchDelete) {
              existingDeleteSeqByKey.set(k, ch.seq);
            }
          }
        }
      }

      const itemsNeedingSeq = group.items.filter(
        (entry) =>
          !existingDeleteSeqByKey.has(`${entry.entityType}:${entry.entityId}`),
      );
      const allocatedSeqs =
        itemsNeedingSeq.length > 0
          ? await this.allocateSequenceBatch(
              group.scope,
              itemsNeedingSeq.length,
              tx,
            )
          : [];
      let allocIdx = 0;
      const deletedAt = new Date();
      const createRows: Prisma.TombstoneCreateManyInput[] = [];
      const missingChangeRows: Prisma.LibraryChangeCreateManyInput[] = [];

      for (const entry of group.items) {
        const k = `${entry.entityType}:${entry.entityId}`;
        const existingSeq = existingDeleteSeqByKey.get(k);
        const seq = existingSeq ?? allocatedSeqs[allocIdx++];
        const effectiveUserId = entry.userId || userId || null;
        const effectiveActorId = this.resolveActorId(
          effectiveUserId,
          entry.deletedById ?? entry.actorId,
        );
        createRows.push({
          scopeKey,
          userId: effectiveUserId,
          projectId: projectId || null,
          entityType: entry.entityType,
          entityId: entry.entityId,
          seq,
          deletedAt,
          deletedById: entry.deletedById ?? effectiveActorId,
        });
        if (existingSeq === undefined) {
          missingChangeRows.push({
            scopeKey,
            seq,
            userId: effectiveUserId,
            actorId: effectiveActorId,
            projectId: projectId || null,
            entityType: entry.entityType,
            entityId: entry.entityId,
            action: 'delete',
            version: 0,
            data: Prisma.DbNull,
          });
        }
      }

      if (missingChangeRows.length > 0) {
        if (client.libraryChange?.createMany) {
          await client.libraryChange.createMany({ data: missingChangeRows });
        } else if (client.libraryChange?.create) {
          for (const row of missingChangeRows) {
            await client.libraryChange.create({ data: row });
          }
        }
      }
      if (client.tombstone?.createMany) {
        const res = await client.tombstone.createMany({
          data: createRows,
          skipDuplicates: true,
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

  async removeTombstone(
    scope: { userId?: string; projectId?: string | null },
    entityType: string,
    entityId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = this.getClient(tx);
    const { userId, projectId } = this.resolveScope(scope);
    const scopeWhere = this.buildScopeWhere(userId, projectId);
    const res = await client.tombstone.deleteMany({
      where: { ...scopeWhere, entityType, entityId },
    });
    return res.count;
  }

  async removeTombstonesBatch(
    scope: { userId?: string; projectId?: string | null },
    entityType: string,
    entityIds: string[],
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    if (!entityIds || entityIds.length === 0) return 0;
    const client = this.getClient(tx);
    const { userId, projectId } = this.resolveScope(scope);
    const scopeWhere = this.buildScopeWhere(userId, projectId);
    const res = await client.tombstone.deleteMany({
      where: { ...scopeWhere, entityType, entityId: { in: entityIds } },
    });
    return res.count;
  }

  async compactAndPurgeChangeLog(
    retentionDays: number = 30,
    batchLimit: number = 1000,
  ): Promise<{ purgedChanges: number; purgedTombstones: number }> {
    const cutoff = new Date(Date.now() - retentionDays * 86400 * 1000);
    const [oldChanges, oldTombstones] = await Promise.all([
      this.prisma.libraryChange.findMany({
        where: { createdAt: { lt: cutoff } },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
        take: batchLimit,
      }),
      this.prisma.tombstone.findMany({
        where: { deletedAt: { lt: cutoff } },
        select: { id: true },
        orderBy: { deletedAt: 'asc' },
        take: batchLimit,
      }),
    ]);
    const [delChanges, delTombstones] = await Promise.all([
      oldChanges.length > 0
        ? this.prisma.libraryChange.deleteMany({
            where: { id: { in: oldChanges.map((c) => c.id) } },
          })
        : Promise.resolve({ count: 0 }),
      oldTombstones.length > 0
        ? this.prisma.tombstone.deleteMany({
            where: { id: { in: oldTombstones.map((t) => t.id) } },
          })
        : Promise.resolve({ count: 0 }),
    ]);
    return {
      purgedChanges: delChanges.count,
      purgedTombstones: delTombstones.count,
    };
  }

  private buildPrivateStateExcludedWhere(userId?: string, projectId?: string | null) {
    if (!projectId) return { userId, projectId: null };
    return {
      projectId,
      ...(userId
        ? {
            OR: [
              { entityType: { notIn: ['State', 'state', 'STATE', 'AttachmentReadingState', 'attachmentreadingstate'] } },
              { userId },
              { userId: null },
            ],
          }
        : {}),
    };
  }

  async getChangesSince(
    scope: { userId?: string; projectId?: string | null },
    sinceSeq: bigint | number,
    limit: number = 100,
  ): Promise<LibraryChange[]> {
    const { userId, projectId } = this.resolveScope(scope);
    const seqBigInt = typeof sinceSeq === 'bigint' ? sinceSeq : BigInt(sinceSeq);
    return this.prisma.libraryChange.findMany({
      where: { ...this.buildPrivateStateExcludedWhere(userId, projectId), seq: { gt: seqBigInt } },
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
    const seqBigInt = sinceSeq !== undefined ? (typeof sinceSeq === 'bigint' ? sinceSeq : BigInt(sinceSeq)) : undefined;
    return this.prisma.tombstone.findMany({
      where: {
        ...this.buildPrivateStateExcludedWhere(userId, projectId),
        ...(seqBigInt !== undefined ? { seq: { gt: seqBigInt } } : {}),
      },
      orderBy: { seq: 'asc' },
      take: limit,
    });
  }

  async getMinRetainedSequence(
    scope: { userId?: string; projectId?: string | null },
  ): Promise<bigint | null> {
    const { userId, projectId } = this.resolveScope(scope);
    const scopeWhere = projectId ? { projectId } : { userId, projectId: null };
    const [firstChange, firstTombstone] = await Promise.all([
      this.prisma.libraryChange.findFirst({
        where: scopeWhere,
        orderBy: { seq: 'asc' },
        select: { seq: true },
      }),
      this.prisma.tombstone.findFirst({
        where: scopeWhere,
        orderBy: { seq: 'asc' },
        select: { seq: true },
      }),
    ]);
    if (!firstChange && !firstTombstone) {
      if (this.prisma.syncSequence?.findUnique) {
        const syncSeq = projectId
          ? await this.prisma.syncSequence.findUnique({
              where: { projectId },
              select: { currentSequence: true },
            })
          : userId
            ? await this.prisma.syncSequence.findUnique({
                where: { userId },
                select: { currentSequence: true },
              })
            : null;
        if (syncSeq && syncSeq.currentSequence > 0n) {
          return syncSeq.currentSequence + 1n;
        }
      }
      return null;
    }
    if (!firstChange && firstTombstone) return firstTombstone.seq;
    if (!firstTombstone && firstChange) return firstChange.seq;
    if (firstChange && firstTombstone) {
      return firstChange.seq < firstTombstone.seq
        ? firstChange.seq
        : firstTombstone.seq;
    }
    return null;
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

export {
  evaluateOutboxFailureDecision,
  computeOutboxDiagnostics,
  type OutboxMetricsRecorder,
  type OutboxFailureDecision,
  type OutboxDiagnosticSummary,
} from '../domain/sync-compaction.policy';
