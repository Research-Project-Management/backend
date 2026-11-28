/**
 * git-bridge/services/maintenance.service.ts
 * GoF Observer (`@OnEvent`) + BCNF-Backed Scheduled Eviction Sweep for bare Git repos & expired PATs.
 */

import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { RepoAdapter } from '../adapters/repo.adapter';
import { GitBridgeRepository } from '../git-bridge.repository';
import { IDLE_TTL_MS, parseRepoId, SWEEP_MS } from '../domain/policy';

@Injectable()
export class MaintenanceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MaintenanceService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly gitRepo: RepoAdapter,
    private readonly repo: GitBridgeRepository,
  ) {}

  public onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.sweep().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Git maintenance sweep failed: ${msg}`);
      });
    }, SWEEP_MS);
    this.timer.unref?.();
  }

  public onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  @OnEvent('pages.page.deleted', { async: true })
  public async onPageDeleted(ev: { pageId?: string }): Promise<void> {
    if (ev?.pageId) await this.gitRepo.evict(ev.pageId);
  }

  @OnEvent('project.deleted', { async: true })
  public async onProjectDeleted(ev: {
    projectId?: string;
    entityId?: string;
  }): Promise<void> {
    const spaceId = ev?.projectId || ev?.entityId;
    if (!spaceId) return;
    const pageIds = await this.repo.findSpacePageIds(spaceId);
    const ids = new Set([spaceId, ...pageIds]);
    await Promise.all(Array.from(ids).map((id) => this.gitRepo.evict(id)));
  }

  public async sweep(
    idleTtlMs: number = IDLE_TTL_MS,
    nowMs: number = Date.now(),
  ): Promise<{ evictedRepos: number; prunedTokens: number }> {
    const cutoff = new Date(nowMs - idleTtlMs);
    const [prunedTokens, dbIdleIds, diskEntries] = await Promise.all([
      this.repo.pruneAllExpired(new Date(nowMs)).catch(() => 0),
      this.repo.findIdleMaterializedPageIds(cutoff).catch(() => [] as string[]),
      fsp
        .readdir(this.gitRepo.rootDir, { withFileTypes: true })
        .catch(() => []),
    ]);

    const toEvict = new Set<string>(dbIdleIds);
    const touched = this.gitRepo.getTouchedMap();

    for (const entry of diskEntries) {
      if (!entry.isDirectory() || !entry.name.endsWith('.git')) continue;
      const repoId = parseRepoId(entry.name);
      if (!repoId || toEvict.has(repoId)) continue;

      let lastMs = touched.get(repoId);
      if (lastMs === undefined) {
        const stat = await fsp
          .stat(path.join(this.gitRepo.rootDir, entry.name, 'HEAD'))
          .catch(() => null);
        lastMs = stat?.mtimeMs ?? 0;
      }

      if (nowMs - lastMs > idleTtlMs) {
        toEvict.add(repoId);
      }
    }

    const evictedIds = Array.from(toEvict);
    if (evictedIds.length > 0) {
      await Promise.all(evictedIds.map((id) => this.gitRepo.evict(id)));
      await this.repo.markReposEvicted(evictedIds);
    }

    if (evictedIds.length > 0 || prunedTokens > 0) {
      this.logger.log(
        `Git sweep: evicted ${evictedIds.length} idle repos, pruned ${prunedTokens} expired tokens`,
      );
    }
    return { evictedRepos: evictedIds.length, prunedTokens };
  }
}
