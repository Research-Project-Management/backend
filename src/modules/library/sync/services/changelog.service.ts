import { Injectable } from '@nestjs/common';
import { Prisma, LibraryChange, Tombstone } from '@prisma/client';
import { ChangeLogRepository } from '@/modules/library/sync/repositories/changelog.repository';
import {
  compactLibraryChanges,
  CompactableChange,
} from '@/modules/library/sync/domain/outbox.domain';
import {
  AppendChangeEntry,
  RecordTombstoneEntry,
} from '@/modules/library/shared-kernel/ports/unit-of-work.port';

export interface GetChangesOptions {
  since?: bigint | number | string;
  limit?: number;
  compact?: boolean;
}

@Injectable()
export class ChangeLogService {
  constructor(private readonly repo: ChangeLogRepository) {}

  async getLatestSequence(
    scope: { userId?: string; projectId?: string } | string,
  ): Promise<bigint> {
    return this.repo.getLatestSequence(scope);
  }

  async appendChange(
    scope: { userId?: string; projectId?: string } | string,
    entry: AppendChangeEntry,
    tx?: Prisma.TransactionClient,
  ): Promise<LibraryChange> {
    return this.repo.appendChange(scope, entry, tx);
  }

  async recordTombstone(
    scope: { userId?: string; projectId?: string } | string,
    entry: RecordTombstoneEntry,
    tx?: Prisma.TransactionClient,
  ): Promise<Tombstone> {
    return this.repo.recordTombstone(scope, entry, tx);
  }

  async getChangesSince(
    scope: { userId?: string; projectId?: string } | string,
    sinceSeq: bigint | number = 0n,
    limit: number = 100,
    options?: { compact?: boolean },
  ): Promise<LibraryChange[]> {
    const raw = await this.repo.getChangesSince(scope, sinceSeq, limit);
    if (options?.compact !== false) {
      return compactLibraryChanges(raw);
    }
    return raw;
  }

  async getTombstonesSince(
    scope: { userId?: string; projectId?: string } | string,
    sinceSeq?: bigint | number,
    limit: number = 100,
  ): Promise<Tombstone[]> {
    return this.repo.getTombstonesSince(scope, sinceSeq, limit);
  }

  compactChanges<T extends CompactableChange>(changes: T[]): T[] {
    return compactLibraryChanges(changes);
  }
}
