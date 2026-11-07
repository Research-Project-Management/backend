/**
 * modules/manuscripts/core/ports/distributed-lock.port.ts
 *
 * Distributed Lock Port (System Design - Concurrency & Mutual Exclusion).
 * Guarantees single-worker execution across multi-replica deployments
 * for critical section workflows (Git Push, CLSI Compilation, Project Restore).
 */

export interface IDistributedLockHandle {
  readonly resource: string;
  readonly acquiredAt: number;
  release(): Promise<void>;
}

export abstract class IDistributedLockPort {
  /**
   * Acquires an exclusive lease for `resource` with a time-to-live (`ttlMs`).
   * Returns a release handle if acquired, or null if currently locked by another worker.
   */
  abstract acquire(
    resource: string,
    ttlMs?: number,
  ): Promise<IDistributedLockHandle | null>;

  /**
   * Executes an asynchronous task within a locked resource boundary.
   * Ensures the lock is guaranteed to be released in a `finally` block.
   */
  abstract withLock<T>(
    resource: string,
    action: () => Promise<T>,
    ttlMs?: number,
  ): Promise<T>;
}

export class InMemoryDistributedLockAdapter implements IDistributedLockPort {
  private readonly locks = new Map<string, Promise<void>>();
  private readonly waiters = new Map<string, Array<() => void>>();

  public async acquire(
    resource: string,
    ttlMs: number = 30000,
  ): Promise<IDistributedLockHandle | null> {
    if (this.locks.has(resource)) {
      return null;
    }

    let releaseResolve!: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });

    this.locks.set(resource, lockPromise);
    const acquiredAt = Date.now();
    let released = false;

    const releaseFn = async () => {
      if (released) return;
      released = true;
      if (ttlTimer) {
        clearTimeout(ttlTimer);
      }
      if (this.locks.get(resource) === lockPromise) {
        this.locks.delete(resource);
      }
      releaseResolve();
      const queue = this.waiters.get(resource);
      if (queue && queue.length > 0) {
        const nextWaiter = queue.shift()!;
        if (queue.length === 0) {
          this.waiters.delete(resource);
        }
        nextWaiter();
      }
    };

    const ttlTimer =
      ttlMs > 0
        ? setTimeout(() => {
            void releaseFn();
          }, ttlMs)
        : null;
    if (ttlTimer && typeof ttlTimer.unref === 'function') {
      ttlTimer.unref();
    }

    return {
      resource,
      acquiredAt,
      release: releaseFn,
    };
  }

  public async withLock<T>(
    resource: string,
    action: () => Promise<T>,
    ttlMs: number = 30000,
  ): Promise<T> {
    let handle = await this.acquire(resource, ttlMs);
    while (!handle) {
      await new Promise<void>((resolve) => {
        let queue = this.waiters.get(resource);
        if (!queue) {
          queue = [];
          this.waiters.set(resource, queue);
        }
        queue.push(resolve);
      });
      handle = await this.acquire(resource, ttlMs);
    }

    try {
      return await action();
    } finally {
      await handle.release().catch(() => {});
    }
  }
}
