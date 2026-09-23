/**
 * document-updater/core/adapters/scheduler/node-timeout-debounce.adapter.ts
 * Driven Adapter implementing IDebounceTimerPort using Node.js setTimeout / clearTimeout.
 */

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { IDebounceTimerPort } from '../../ports/debounce-timer.port';

@Injectable()
export class NodeTimeoutDebounceAdapter extends IDebounceTimerPort implements OnModuleDestroy {
  private readonly logger = new Logger(NodeTimeoutDebounceAdapter.name);
  private readonly timers = new Map<string, NodeJS.Timeout>();

  private toKey(projectId: string, docId: string): string {
    return `${projectId}:${docId}`;
  }

  public schedule(
    projectId: string,
    docId: string,
    delayMs: number,
    callback: () => Promise<void>,
  ): void {
    const key = this.toKey(projectId, docId);
    this.cancel(projectId, docId);

    const timer = setTimeout(async () => {
      this.timers.delete(key);
      try {
        await callback();
      } catch (err) {
        this.logger.error(
          `Debounced flush failed for doc '${docId}' in project '${projectId}': ${(err as Error).message}`,
        );
      }
    }, delayMs);

    // Unref so timers don't block node process exit
    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    this.timers.set(key, timer);
  }

  public cancel(projectId: string, docId: string): void {
    const key = this.toKey(projectId, docId);
    const existing = this.timers.get(key);
    if (existing) {
      clearTimeout(existing);
      this.timers.delete(key);
    }
  }

  public cancelAllForProject(projectId: string): void {
    const prefix = `${projectId}:`;
    for (const [k, t] of this.timers.entries()) {
      if (k.startsWith(prefix)) {
        clearTimeout(t);
        this.timers.delete(k);
      }
    }
  }

  public cancelAll(): void {
    for (const t of this.timers.values()) {
      clearTimeout(t);
    }
    this.timers.clear();
  }

  public onModuleDestroy(): void {
    this.cancelAll();
  }
}
