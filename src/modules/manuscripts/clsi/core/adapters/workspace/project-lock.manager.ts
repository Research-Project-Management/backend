/**
 * modules/manuscripts/clsi/core/adapters/workspace/project-lock.manager.ts
 * Manages project-level compilation locks (.project-lock) to prevent simultaneous
 * compilations from corrupting disk state or colliding on auxiliary files.
 * Matches Overleaf CLSI LockManager.js semantics.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

export interface LockOptions {
  intervalMs?: number;
  maxWaitMs?: number;
  staleMs?: number;
}

export class ProjectLockManager {
  private static readonly LOCK_FILENAME = '.project-lock';
  private static readonly DEFAULT_INTERVAL_MS = 100; // 100ms polling
  private static readonly DEFAULT_MAX_WAIT_MS = 15000; // 15s max wait (Overleaf parity)
  private static readonly DEFAULT_STALE_MS = 5 * 60 * 1000; // 5 mins auto-expiry

  private static inMemoryLocks = new Map<string, Promise<void>>();

  public async runWithLock<T>(
    projectId: string,
    scratchDir: string,
    action: () => Promise<T>,
    options?: LockOptions
  ): Promise<T> {
    const unlock = await this.acquire(projectId, scratchDir, options);
    try {
      return await action();
    } finally {
      await unlock();
    }
  }

  public async acquire(
    projectId: string,
    scratchDir: string,
    options?: LockOptions
  ): Promise<() => Promise<void>> {
    const interval = options?.intervalMs ?? ProjectLockManager.DEFAULT_INTERVAL_MS;
    const maxWait = options?.maxWaitMs ?? ProjectLockManager.DEFAULT_MAX_WAIT_MS;
    const staleMs = options?.staleMs ?? ProjectLockManager.DEFAULT_STALE_MS;

    const lockPath = path.join(scratchDir, ProjectLockManager.LOCK_FILENAME);
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      try {
        // Atomic file creation with 'wx' flag (exclusive write, fails if file exists)
        const lockInfo = JSON.stringify({
          projectId,
          pid: process.pid,
          acquiredAt: new Date().toISOString(),
          timestamp: Date.now(),
        });
        await fs.writeFile(lockPath, lockInfo, { flag: 'wx' });

        // Lock acquired successfully
        return async () => {
          try {
            await fs.unlink(lockPath);
          } catch {
            // Lockfile may have already been cleaned
          }
        };
      } catch (err: any) {
        if (err.code === 'EEXIST' || err.code === 'EPERM' || err.code === 'EBUSY') {
          // Check if existing lockfile is stale (> staleMs)
          try {
            const stat = await fs.stat(lockPath);
            const age = Date.now() - stat.mtimeMs;
            if (age > staleMs) {
              // Stale lock detected (previous compile crashed or hung): break lock
              await fs.unlink(lockPath);
              continue;
            }
          } catch {
            // Lock was removed between stat and unlink, retry next iteration
            continue;
          }

          // Wait before next attempt
          await new Promise((resolve) => setTimeout(resolve, interval));
        } else if (err.code === 'ENOENT') {
          // Directory doesn't exist yet, create it and retry
          await fs.mkdir(scratchDir, { recursive: true });
        } else {
          throw err;
        }
      }
    }

    throw new Error(
      `Project compilation lock timed out after ${maxWait}ms for project "${projectId}". Another compilation is currently in progress.`
    );
  }
}
