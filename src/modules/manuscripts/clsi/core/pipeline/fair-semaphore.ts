/**
 * clsi/core/pipeline/fair-semaphore.ts
 *
 * Counting semaphore with per-tenant fair scheduling.
 *
 * Problem: LaTeX compiles are CPU/RAM heavy (a few hundred MB, seconds of a full core).
 * The old queue only guaranteed "one compile per project", so N active projects meant N
 * parallel latexmk processes → CPU saturation, OOM kills and tail latency for everyone.
 *
 * Design:
 *  - `capacity` slots run concurrently (bounded resource usage).
 *  - Waiters are held in one FIFO per tenant key and tenants are served round-robin, so a
 *    user who fires 50 requests cannot starve a user who fires one (max-min fairness,
 *    equivalent to deficit round robin with unit-size jobs).
 *  - `maxQueue` caps memory and gives immediate back-pressure (fail fast instead of
 *    letting latency grow unbounded); `maxWaitMs` bounds time in queue.
 *  - Waiters are abort-aware: a superseded/cancelled request leaves the queue in
 *    O(queue length of its tenant) and never consumes a slot.
 *
 * Complexity: acquire O(1); release/dispatch O(1) amortised (O(T) only when a tenant's
 * queue empties, T = number of tenants currently waiting).
 */

export class SemaphoreQueueFullError extends Error {
  constructor(public readonly maxQueue: number) {
    super(`Compile queue is full (${maxQueue} waiting)`);
    this.name = 'SemaphoreQueueFullError';
  }
}

export class SemaphoreWaitTimeoutError extends Error {
  constructor(public readonly waitedMs: number) {
    super(`Timed out after ${waitedMs}ms waiting for a compile slot`);
    this.name = 'SemaphoreWaitTimeoutError';
  }
}

export class SemaphoreAbortedError extends Error {
  constructor() {
    super('Wait for compile slot aborted');
    this.name = 'SemaphoreAbortedError';
  }
}

export interface SemaphoreStats {
  capacity: number;
  active: number;
  waiting: number;
  waitingTenants: number;
}

interface Waiter {
  key: string;
  grant: () => void;
  reject: (err: Error) => void;
  cleanup: () => void;
}

export class FairSemaphore {
  private active = 0;
  private waiting = 0;
  private readonly queues = new Map<string, Waiter[]>();
  /** Tenant keys that currently have waiters, in service order. */
  private readonly ring: string[] = [];
  private cursor = 0;

  constructor(
    public readonly capacity: number,
    public readonly maxQueue: number = Number.POSITIVE_INFINITY,
    public readonly maxWaitMs: number = Number.POSITIVE_INFINITY,
  ) {
    if (!(capacity >= 1)) throw new RangeError('capacity must be >= 1');
  }

  public stats(): SemaphoreStats {
    return {
      capacity: this.capacity,
      active: this.active,
      waiting: this.waiting,
      waitingTenants: this.ring.length,
    };
  }

  /**
   * Synchronous fast path: grabs a slot only if one is free AND nobody is queued ahead
   * (preserving fairness). Returns the release function, or null if the caller must wait.
   */
  public tryAcquire(): (() => void) | null {
    if (this.active < this.capacity && this.waiting === 0) {
      this.active++;
      return this.makeRelease();
    }
    return null;
  }

  /**
   * Resolves with a one-shot `release` function once a slot is granted.
   * Callers MUST call `release()` in a `finally`.
   */
  public acquire(key: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new SemaphoreAbortedError());

    const fast = this.tryAcquire();
    if (fast) return Promise.resolve(fast);

    if (this.waiting >= this.maxQueue) {
      return Promise.reject(new SemaphoreQueueFullError(this.maxQueue));
    }

    return new Promise<() => void>((resolve, reject) => {
      const enqueuedAt = Date.now();
      let timer: NodeJS.Timeout | undefined;
      let onAbort: (() => void) | undefined;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (onAbort && signal) signal.removeEventListener('abort', onAbort);
      };

      const waiter: Waiter = {
        key,
        cleanup,
        reject: (err) => {
          cleanup();
          reject(err);
        },
        grant: () => {
          cleanup();
          resolve(this.makeRelease());
        },
      };

      if (Number.isFinite(this.maxWaitMs)) {
        timer = setTimeout(() => {
          if (this.removeWaiter(waiter)) {
            cleanup();
            reject(new SemaphoreWaitTimeoutError(Date.now() - enqueuedAt));
          }
        }, this.maxWaitMs);
        timer.unref?.();
      }

      if (signal) {
        onAbort = () => {
          if (this.removeWaiter(waiter)) {
            cleanup();
            reject(new SemaphoreAbortedError());
          }
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }

      this.enqueue(waiter);
    });
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.dispatch();
    };
  }

  private enqueue(waiter: Waiter): void {
    let q = this.queues.get(waiter.key);
    if (!q) {
      q = [];
      this.queues.set(waiter.key, q);
      this.ring.push(waiter.key);
    }
    q.push(waiter);
    this.waiting++;
  }

  /** @returns true if the waiter was still queued (and is now removed). */
  private removeWaiter(waiter: Waiter): boolean {
    const q = this.queues.get(waiter.key);
    if (!q) return false;
    const idx = q.indexOf(waiter);
    if (idx === -1) return false;
    q.splice(idx, 1);
    this.waiting--;
    if (q.length === 0) this.dropTenant(waiter.key);
    return true;
  }

  private dropTenant(key: string): void {
    this.queues.delete(key);
    const ringIdx = this.ring.indexOf(key);
    if (ringIdx === -1) return;
    this.ring.splice(ringIdx, 1);
    // Elements after ringIdx shifted left; keep the cursor pointing at the same "next".
    if (ringIdx < this.cursor) this.cursor--;
    if (this.cursor >= this.ring.length) this.cursor = 0;
  }

  private dispatch(): void {
    while (this.active < this.capacity && this.waiting > 0) {
      if (this.cursor >= this.ring.length) this.cursor = 0;
      const key = this.ring[this.cursor];
      const q = this.queues.get(key)!;
      const waiter = q.shift()!;
      this.waiting--;
      this.active++;

      if (q.length === 0) {
        this.dropTenant(key); // cursor now already points at the next tenant
      } else {
        this.cursor = (this.cursor + 1) % this.ring.length;
      }
      waiter.grant();
    }
  }
}
