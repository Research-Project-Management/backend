import { Injectable, Logger, Optional } from '@nestjs/common';
import { ItemsRepository } from '../items/items.repository';
import { ChangeLogRepository } from '@/modules/library/sync-core/change-log.repository';
import { LibraryFeatureFlagsService } from '@/modules/library/common/library-feature-flags';

import {
  LibraryChange,
  LibraryEntityType,
  LibraryChangeAction,
  GetChangesResponse,
  SyncPushMutation,
  SyncPushResult,
  SyncPushConflict,
} from './types/sync.types';

import { RedisCacheService } from '@/core/cache/redis-cache.service';

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);
  private readonly workspaceSeqs = new Map<string, number>();
  private readonly workspaceChanges = new Map<string, LibraryChange[]>();

  constructor(
    private readonly itemsRepo: ItemsRepository,
    @Optional() private readonly changeLogRepo?: ChangeLogRepository,
    @Optional() private readonly featureFlags?: LibraryFeatureFlagsService,
    @Optional() private readonly redisCache?: RedisCacheService,
  ) {}

  /**
   * Records a library entity mutation into the workspace change log stream
   */
  async recordChange(
    workspaceId: string,
    entityType: LibraryEntityType,
    entityId: string,
    action: LibraryChangeAction,
    version: number,
    data?: Record<string, unknown>,
  ): Promise<LibraryChange> {
    const targetWsId = await this.itemsRepo.resolveWorkspaceId(workspaceId);

    // If changeLogRepo is available, also persist durably
    let persistedSeq: number | undefined;
    if (this.changeLogRepo) {
      try {
        const appended = await this.changeLogRepo.appendChange(targetWsId, {
          entityType,
          entityId,
          action,
          version,
          data: data ?? {},
        });
        persistedSeq = Number(appended.seq);
      } catch (err: any) {
        this.logger.warn(
          `Failed to persist durable change for ${entityId}: ${err?.message}`,
        );
      }
    }

    const currentSeq =
      persistedSeq ?? (this.workspaceSeqs.get(targetWsId) || 0) + 1;
    this.workspaceSeqs.set(targetWsId, currentSeq);

    const change: LibraryChange = {
      seq: currentSeq,
      workspaceId: targetWsId,
      entityType,
      entityId,
      action,
      version,
      timestamp: new Date().toISOString(),
      data,
    };

    const list = this.workspaceChanges.get(targetWsId) || [];
    list.push(change);

    // Keep last 10,000 changes in memory per workspace
    if (list.length > 10000) {
      list.shift();
    }
    this.workspaceChanges.set(targetWsId, list);

    return change;
  }

  /**
   * Returns incremental change feed since a given sequence number
   */
  async getChanges(
    workspaceId: string,
    afterSeq: number = 0,
    limit: number = 100,
  ): Promise<GetChangesResponse> {
    const targetWsId = await this.itemsRepo.resolveWorkspaceId(workspaceId);

    // If changeLogRepo is available and feature flag or DB has changes
    if (this.changeLogRepo) {
      try {
        const changes = await this.changeLogRepo.getChangesSince(
          targetWsId,
          afterSeq,
          limit,
        );
        const latestSeq =
          await this.changeLogRepo.getLatestSequence(targetWsId);

        if (changes.length > 0 || latestSeq > 0) {
          return {
            changes: changes.map((c) => ({
              seq: Number(c.seq),
              workspaceId: c.workspaceId,
              entityType: c.entityType as LibraryEntityType,
              entityId: c.entityId,
              action: c.action as LibraryChangeAction,
              version: c.version,
              timestamp: c.timestamp
                ? new Date(c.timestamp).toISOString()
                : new Date().toISOString(),
              data: (c.data as Record<string, unknown>) ?? {},
            })),

            latestSeq: Number(latestSeq),
            hasMore: changes.length >= limit,
          };
        }
      } catch (err: any) {
        this.logger.warn(
          `Failed to query durable changes for ${targetWsId}: ${err?.message}`,
        );
      }
    }

    const list = this.workspaceChanges.get(targetWsId) || [];
    const latestSeq = this.workspaceSeqs.get(targetWsId) || 0;

    const filtered = list.filter((c) => c.seq > afterSeq);
    const maxLimit = Math.min(500, Math.max(1, limit));
    const paginated = filtered.slice(0, maxLimit);
    const hasMore = filtered.length > maxLimit;

    return {
      changes: paginated,
      latestSeq,
      hasMore,
    };
  }

  /**
   * Handles batch push from offline clients with optimistic concurrency conflict detection
   */
  async pushChanges(
    workspaceId: string,
    mutations: SyncPushMutation[],
  ): Promise<SyncPushResult> {
    const targetWsId = await this.itemsRepo.resolveWorkspaceId(workspaceId);
    const applied: Array<{
      entityId: string;
      newVersion: number;
      seq: number;
    }> = [];
    const conflicts: SyncPushConflict[] = [];

    for (const mutation of mutations) {
      if (mutation.entityType === 'item') {
        const existing = await this.itemsRepo.findItemByIdInWorkspace(
          targetWsId,
          mutation.entityId,
        );

        if (mutation.action === 'create') {
          if (existing && !existing.deletedAt) {
            conflicts.push({
              entityId: mutation.entityId,
              serverVersion: (existing as any).version || 1,
              baseVersion: mutation.baseVersion,
              serverData: existing as any,
              message: 'Item already exists on server',
            });
            continue;
          }

          // Create item
          const newVersion = 1;
          const change = await this.recordChange(
            targetWsId,
            'item',
            mutation.entityId,
            'create',
            newVersion,
            mutation.data,
          );
          applied.push({
            entityId: mutation.entityId,
            newVersion,
            seq: change.seq,
          });
        } else if (mutation.action === 'update') {
          if (!existing || existing.deletedAt) {
            conflicts.push({
              entityId: mutation.entityId,
              serverVersion: 0,
              baseVersion: mutation.baseVersion,
              message: 'Item not found on server',
            });
            continue;
          }

          const serverVersion = (existing as any).version || 1;
          if (serverVersion !== mutation.baseVersion) {
            conflicts.push({
              entityId: mutation.entityId,
              serverVersion,
              baseVersion: mutation.baseVersion,
              serverData: existing as any,
              message:
                'Optimistic concurrency conflict: baseVersion does not match server version',
            });
            continue;
          }

          const newVersion = serverVersion + 1;
          await this.itemsRepo.updateItem(existing.id, {
            ...(mutation.data as any),
            version: newVersion,
          });

          const change = await this.recordChange(
            targetWsId,
            'item',
            mutation.entityId,
            'update',
            newVersion,
            mutation.data,
          );

          applied.push({
            entityId: mutation.entityId,
            newVersion,
            seq: change.seq,
          });
        } else if (mutation.action === 'delete') {
          if (!existing || existing.deletedAt) {
            // Already deleted, consider applied
            applied.push({
              entityId: mutation.entityId,
              newVersion: 0,
              seq: this.workspaceSeqs.get(targetWsId) || 0,
            });
            continue;
          }

          await this.itemsRepo.updateItem(existing.id, {
            deletedAt: new Date(),
          });

          const change = await this.recordChange(
            targetWsId,
            'item',
            mutation.entityId,
            'delete',
            ((existing as any).version || 1) + 1,
          );

          applied.push({
            entityId: mutation.entityId,
            newVersion: ((existing as any).version || 1) + 1,
            seq: change.seq,
          });
        }
      } else {
        // Non-item entity types (collection, tag, note, annotation)
        const newVersion = mutation.baseVersion + 1;
        const change = await this.recordChange(
          targetWsId,
          mutation.entityType,
          mutation.entityId,
          mutation.action,
          newVersion,
          mutation.data,
        );
        applied.push({
          entityId: mutation.entityId,
          newVersion,
          seq: change.seq,
        });
      }
    }

    return { applied, conflicts };
  }
}
