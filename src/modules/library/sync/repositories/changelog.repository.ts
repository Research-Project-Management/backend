import {
  Injectable,
  Logger,
  BadRequestException,
  InternalServerErrorException,
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
  ) {
    if (typeof scope === 'string') {
      if (scope.startsWith('proj:')) {
        return { userId: undefined, projectId: scope.slice(5) };
      }
      if (scope.startsWith('user:')) {
        return { userId: scope.slice(5), projectId: undefined };
      }
      return { userId: scope, projectId: undefined };
    }
    return {
      userId: scope.userId,
      projectId: normalizeProjectScopeId(scope.projectId),
    };
  }

  async allocateNextSequence(
    scope: { userId?: string; projectId?: string | null } | string,
    countOrTx: number | Prisma.TransactionClient = 1,
    tx?: Prisma.TransactionClient,
  ): Promise<bigint> {
    const count = typeof countOrTx === 'number' ? countOrTx : 1;
    const client =
      (typeof countOrTx !== 'number' ? countOrTx : tx) || this.prisma;
    const { userId, projectId } = this.resolveScope(scope);
    const incrementBy = BigInt(count);

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
      return record.currentSequence;
    }

    if (userId) {
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

    // If a tombstone already created a 'delete' LibraryChange for this entity in the same scope,
    // update it in place ONLY if there is no newer change for this entity.
    if (entry.action === 'delete' && client.libraryChange?.findFirst) {
      const existingDeleteChange = await client.libraryChange.findFirst({
        where: {
          userId: userId || null,
          projectId: projectId || null,
          entityType: entry.entityType,
          entityId: entry.entityId,
          action: 'delete',
        },
        orderBy: { seq: 'desc' },
        select: { id: true, seq: true, data: true },
      });
      if (existingDeleteChange && client.libraryChange?.update) {
        const newerChange = await client.libraryChange.findFirst({
          where: {
            userId: userId || null,
            projectId: projectId || null,
            entityType: entry.entityType,
            entityId: entry.entityId,
            seq: { gt: existingDeleteChange.seq },
          },
          select: { id: true },
        });
        if (!newerChange) {
          const nextData =
            entry.data !== undefined && entry.data !== null
              ? (entry.data as Prisma.InputJsonValue)
              : existingDeleteChange.data != null
                ? (existingDeleteChange.data as Prisma.InputJsonValue)
                : Prisma.DbNull;
          return client.libraryChange.update({
            where: { id: existingDeleteChange.id },
            data: {
              version: entry.version,
              data: nextData,
            },
          });
        }
      }
    }

    const seq = await this.allocateNextSequence(scope, 1, tx);

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
    let updatedExistingCount = 0;

    for (const group of byScope.values()) {
      const { userId, projectId } = group.scope;
      const deleteEntries = group.items.filter((it) => it.action === 'delete');
      const existingDeleteByKey = new Map<
        string,
        { id: string; data: unknown }
      >();

      if (deleteEntries.length > 0 && client.libraryChange?.findMany) {
        const entityIds = Array.from(
          new Set(deleteEntries.map((d) => d.entityId)),
        );
        const existingChanges = await client.libraryChange.findMany({
          where: {
            userId: userId || null,
            projectId: projectId || null,
            entityId: { in: entityIds },
          },
          orderBy: { seq: 'desc' },
          select: {
            id: true,
            entityType: true,
            entityId: true,
            action: true,
            seq: true,
            data: true,
          },
        });
        const seenKeys = new Set<string>();
        for (const ch of existingChanges) {
          const k = `${ch.entityType}:${ch.entityId}`;
          if (!seenKeys.has(k)) {
            seenKeys.add(k);
            if (ch.action === 'delete') {
              existingDeleteByKey.set(k, { id: ch.id, data: ch.data });
            }
          }
        }
      }

      const itemsNeedingNewRow: AppendChangeInput[] = [];
      const updatePromises: Promise<unknown>[] = [];
      for (const entry of group.items) {
        const existingMatch =
          entry.action === 'delete'
            ? existingDeleteByKey.get(`${entry.entityType}:${entry.entityId}`)
            : undefined;
        if (existingMatch && client.libraryChange?.update) {
          const nextData =
            entry.data !== undefined && entry.data !== null
              ? (entry.data as Prisma.InputJsonValue)
              : existingMatch.data != null
                ? (existingMatch.data as Prisma.InputJsonValue)
                : Prisma.DbNull;
          updatePromises.push(
            client.libraryChange.update({
              where: { id: existingMatch.id },
              data: {
                version: entry.version,
                data: nextData,
              },
            }),
          );
          updatedExistingCount++;
        } else {
          itemsNeedingNewRow.push(entry);
        }
      }
      if (updatePromises.length > 0) {
        await Promise.all(updatePromises);
      }

      if (itemsNeedingNewRow.length > 0) {
        const seqs = await this.allocateSequenceBatch(
          group.scope,
          itemsNeedingNewRow.length,
          tx,
        );
        itemsNeedingNewRow.forEach((entry, idx) => {
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
    }

    if (createRows.length === 0) {
      return updatedExistingCount;
    }

    if (client.libraryChange?.createMany) {
      const res = await client.libraryChange.createMany({
        data: createRows,
      });
      return res.count + updatedExistingCount;
    }

    for (const row of createRows) {
      await client.libraryChange.create({ data: row });
    }
    return createRows.length + updatedExistingCount;
  }

  async recordTombstone(
    scope: { userId?: string; projectId?: string | null },
    entry: RecordTombstoneEntry,
    tx?: Prisma.TransactionClient,
  ): Promise<Tombstone> {
    const client = this.getClient(tx);
    const { userId, projectId } = this.resolveScope(scope);

    // Check if a 'delete' LibraryChange was already recorded for this entity in the same scope
    // and is still the latest change (no newer create/update occurred since).
    let existingDeleteChange: {
      id: string;
      seq: bigint;
      data?: unknown;
    } | null = null;
    if (client.libraryChange?.findFirst) {
      const candidate = await client.libraryChange.findFirst({
        where: {
          userId: userId || null,
          projectId: projectId || null,
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
            userId: userId || null,
            projectId: projectId || null,
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

    // Ensure a corresponding 'delete' entry exists in library_changes so GET /sync/changes observes all tombstones
    if (!existingDeleteChange && client.libraryChange?.create) {
      await client.libraryChange.create({
        data: {
          seq,
          userId: userId || null,
          projectId: projectId || null,
          entityType: entry.entityType,
          entityId: entry.entityId,
          action: 'delete',
          version: 0,
          data: Prisma.DbNull,
        },
      });
    } else if (
      existingDeleteChange &&
      existingDeleteChange.data == null &&
      client.libraryChange?.update
    ) {
      await client.libraryChange.update({
        where: { id: existingDeleteChange.id },
        data: {
          data: Prisma.DbNull,
        },
      });
    }

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

    try {
      return await client.tombstone.create({
        data: {
          userId: userId || null,
          projectId: projectId || null,
          entityType: entry.entityType,
          entityId: entry.entityId,
          seq,
          deletedById: entry.deletedById ?? null,
        },
      });
    } catch {
      const retryExisting = await client.tombstone.findFirst({
        where: {
          userId: userId || null,
          projectId: projectId || null,
          entityType: entry.entityType,
          entityId: entry.entityId,
        },
        select: { id: true },
      });
      if (retryExisting) {
        return client.tombstone.update({
          where: { id: retryExisting.id },
          data: {
            seq,
            deletedAt: new Date(),
            deletedById: entry.deletedById ?? null,
          },
        });
      }
      throw new InternalServerErrorException(
        `Failed to record tombstone for ${entry.entityType}:${entry.entityId}`,
      );
    }
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
      const entityTypes = Array.from(
        new Set(group.items.map((it) => it.entityType)),
      );

      // Remove any stale tombstones for the same entities in this scope, then bulk-insert fresh tombstones
      if (client.tombstone?.deleteMany) {
        await client.tombstone.deleteMany({
          where: {
            userId: userId || null,
            projectId: projectId || null,
            entityType:
              entityTypes.length === 1
                ? entityTypes[0]
                : { in: entityTypes },
            entityId: { in: entityIds },
          },
        });
      }

      const existingDeleteSeqByKey = new Map<string, bigint>();
      if (client.libraryChange?.findMany) {
        const existingChanges = await client.libraryChange.findMany({
          where: {
            userId: userId || null,
            projectId: projectId || null,
            entityId: { in: entityIds },
          },
          orderBy: { seq: 'desc' },
          select: { entityType: true, entityId: true, action: true, seq: true },
        });
        const seenKeys = new Set<string>();
        for (const ch of existingChanges) {
          const k = `${ch.entityType}:${ch.entityId}`;
          if (!seenKeys.has(k)) {
            seenKeys.add(k);
            if (ch.action === 'delete') {
              existingDeleteSeqByKey.set(k, ch.seq);
            }
          }
        }
      }

      const itemsNeedingSeq = group.items.filter(
        (entry) => !existingDeleteSeqByKey.has(`${entry.entityType}:${entry.entityId}`),
      );
      const allocatedSeqs = itemsNeedingSeq.length > 0
        ? await this.allocateSequenceBatch(group.scope, itemsNeedingSeq.length, tx)
        : [];
      let allocIdx = 0;
      const deletedAt = new Date();
      const createRows: Prisma.TombstoneCreateManyInput[] = [];
      const missingChangeRows: Prisma.LibraryChangeCreateManyInput[] = [];

      for (const entry of group.items) {
        const k = `${entry.entityType}:${entry.entityId}`;
        const existingSeq = existingDeleteSeqByKey.get(k);
        const seq = existingSeq ?? allocatedSeqs[allocIdx++];
        createRows.push({
          userId: userId || null,
          projectId: projectId || null,
          entityType: entry.entityType,
          entityId: entry.entityId,
          seq,
          deletedAt,
          deletedById: entry.deletedById ?? null,
        });
        if (existingSeq === undefined) {
          missingChangeRows.push({
            seq,
            userId: userId || null,
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
          for (const row of missingChangeRows) await client.libraryChange.create({ data: row });
        }
      }
      if (client.tombstone?.createMany) {
        const res = await client.tombstone.createMany({ data: createRows });
        totalRecorded += res.count;
      } else {
        for (const row of createRows) await client.tombstone.create({ data: row });
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
    const res = await client.tombstone.deleteMany({
      where: { userId: userId || null, projectId: projectId || null, entityType, entityId },
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
    const res = await client.tombstone.deleteMany({
      where: { userId: userId || null, projectId: projectId || null, entityType, entityId: { in: entityIds } },
    });
    return res.count;
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
    if (!projectId && !userId) {
      throw new BadRequestException('Sync scope must include either a valid userId or projectId');
    }
    const seqBigInt = typeof sinceSeq === 'bigint' ? sinceSeq : BigInt(sinceSeq);
    return this.prisma.libraryChange.findMany({
      where: {
        ...(projectId ? { projectId } : { userId, projectId: null }),
        seq: { gt: seqBigInt },
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
    if (!projectId && !userId) {
      throw new BadRequestException('Sync scope must include either a valid userId or projectId');
    }
    const seqBigInt =
      sinceSeq !== undefined ? (typeof sinceSeq === 'bigint' ? sinceSeq : BigInt(sinceSeq)) : undefined;
    return this.prisma.tombstone.findMany({
      where: {
        ...(projectId ? { projectId } : { userId, projectId: null }),
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
      this.prisma.libraryChange.findFirst({ where: scopeWhere, orderBy: { seq: 'asc' }, select: { seq: true } }),
      this.prisma.tombstone.findFirst({ where: scopeWhere, orderBy: { seq: 'asc' }, select: { seq: true } }),
    ]);
    if (!firstChange && !firstTombstone) {
      if (this.prisma.syncSequence?.findUnique) {
        const syncSeq = projectId
          ? await this.prisma.syncSequence.findUnique({ where: { projectId }, select: { currentSequence: true } })
          : userId
            ? await this.prisma.syncSequence.findUnique({ where: { userId }, select: { currentSequence: true } })
            : null;
        if (syncSeq && syncSeq.currentSequence > 0n) return syncSeq.currentSequence + 1n;
      }
      return null;
    }
    if (!firstChange && firstTombstone) return firstTombstone.seq;
    if (!firstTombstone && firstChange) return firstChange.seq;
    if (firstChange && firstTombstone) {
      return firstChange.seq < firstTombstone.seq ? firstChange.seq : firstTombstone.seq;
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
        ? this.prisma.syncSequence.findUnique({ where: { projectId }, select: { currentSequence: true } })
        : userId
          ? this.prisma.syncSequence.findUnique({ where: { userId }, select: { currentSequence: true } })
          : Promise.resolve(null),
      this.prisma.libraryChange.findFirst({ where: scopeWhere, orderBy: { seq: 'desc' }, select: { seq: true } }),
      this.prisma.tombstone.findFirst({ where: scopeWhere, orderBy: { seq: 'desc' }, select: { seq: true } }),
    ]);
    const seqFromSync = seqRecord?.currentSequence ?? 0n;
    const changeSeq = latestChange?.seq ?? 0n;
    const tombstoneSeq = latestTombstone?.seq ?? 0n;
    const maxCommittedSeq = changeSeq > tombstoneSeq ? changeSeq : tombstoneSeq;
    return maxCommittedSeq > seqFromSync ? maxCommittedSeq : seqFromSync;
  }
}
