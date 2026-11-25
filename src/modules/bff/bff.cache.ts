/**
 * modules/bff/bff.cache.ts
 * Cohesive BFF caching layer:
 * - Redis key builders & short TTL constants
 * - Singleflight request coalescing (prevents Cache Stampede)
 * - Refresh write-back (bypassRead skips cache read but still refreshes Redis)
 * - Event-driven invalidation on domain events (project.**, work-item.**)
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { RedisCacheService } from '@/core';

export const BFF_CACHE_TTL_SECONDS = {
  workspaceShell: 20,
  projectBootstrap: 15,
} as const;

export const BFF_CACHE_KEYS = {
  workspaceShell: (userId: string): string =>
    `flux:bff:web:workspace-shell:${userId}`,
  projectBootstrap: (projectId: string, userId: string): string =>
    `flux:bff:web:project-bootstrap:${projectId}:${userId}`,
  projectBootstrapPattern: (projectId: string): string =>
    `flux:bff:web:project-bootstrap:${projectId}:*`,
} as const;

export interface BffCachedResult<T> {
  value: T;
  cacheHit: boolean;
}

export interface BffDomainChangeEvent {
  entityId?: string;
  projectId?: string;
  verb?: string;
  actorId?: string;
  userId?: string;
  targetUserId?: string;
  oldValue?: string;
  newValue?: string;
}

@Injectable()
export class BffCacheService {
  private readonly logger = new Logger(BffCacheService.name);
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(@Optional() private readonly cache?: RedisCacheService) {}

  async getOrCompute<T>(
    key: string,
    options: { ttlSeconds: number; bypassRead?: boolean },
    compute: () => Promise<{ value: T; cacheable: boolean }>,
  ): Promise<BffCachedResult<T>> {
    const { ttlSeconds, bypassRead = false } = options;

    if (!bypassRead && ttlSeconds > 0 && this.cache) {
      try {
        const cached = await this.cache.get<T>(key);
        if (cached !== null) {
          return { value: cached, cacheHit: true };
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`BFF cache read failed for "${key}": ${msg}`);
      }
    }

    if (!bypassRead) {
      const existing = this.inFlight.get(key) as Promise<T> | undefined;
      if (existing) {
        return { value: await existing, cacheHit: false };
      }
    }

    const execution = (async (): Promise<T> => {
      const { value, cacheable } = await compute();
      if (cacheable && ttlSeconds > 0 && this.cache) {
        try {
          await this.cache.set(key, value, ttlSeconds);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.warn(`BFF cache write failed for "${key}": ${msg}`);
        }
      }
      return value;
    })();

    if (!bypassRead) {
      this.inFlight.set(key, execution);
    }

    try {
      return { value: await execution, cacheHit: false };
    } finally {
      if (!bypassRead) {
        this.inFlight.delete(key);
      }
    }
  }

  getInFlightCount(): number {
    return this.inFlight.size;
  }

  @OnEvent('project.**', { async: true })
  async handleProjectChanged(event: BffDomainChangeEvent): Promise<void> {
    if (!this.cache) return;

    try {
      const projectId = event.entityId || event.projectId;
      const affectedUsers = new Set<string>(
        [
          event.actorId,
          event.userId,
          event.targetUserId,
          event.verb === 'member_removed' ? event.oldValue : undefined,
          event.verb === 'member_added' ? event.newValue : undefined,
          event.verb === 'ownership_transferred' ? event.oldValue : undefined,
          event.verb === 'ownership_transferred' ? event.newValue : undefined,
        ].filter((id): id is string => typeof id === 'string' && id.length > 0),
      );

      const tasks: Promise<unknown>[] = [];
      if (projectId) {
        tasks.push(
          this.cache.delPattern(
            BFF_CACHE_KEYS.projectBootstrapPattern(projectId),
          ),
        );
      }
      for (const uid of affectedUsers) {
        tasks.push(this.cache.del(BFF_CACHE_KEYS.workspaceShell(uid)));
      }

      await Promise.all(tasks);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`BFF project cache invalidation failed: ${msg}`);
    }
  }

  @OnEvent('work-item.**', { async: true })
  async handleWorkItemChanged(event: BffDomainChangeEvent): Promise<void> {
    if (!this.cache) return;

    try {
      const tasks: Promise<unknown>[] = [];
      if (event.projectId) {
        tasks.push(
          this.cache.delPattern(
            BFF_CACHE_KEYS.projectBootstrapPattern(event.projectId),
          ),
        );
      }
      const actorId = event.actorId || event.userId;
      if (actorId) {
        tasks.push(this.cache.del(BFF_CACHE_KEYS.workspaceShell(actorId)));
      }

      await Promise.all(tasks);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`BFF work-item cache invalidation failed: ${msg}`);
    }
  }
}
