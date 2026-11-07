/**
 * modules/manuscripts/clsi/domain/fair-semaphore.ts
 * Pure Domain: Per-Tenant Fair Semaphore & Domain Errors for LaTeX compilation.
 * 100% Pure TypeScript, zero framework dependencies.
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

export class CompileRateLimitExceededError extends Error {
  constructor(public readonly maxPerMinute: number) {
    super(
      `Compilation rate limit exceeded (${maxPerMinute} runs/min). Please wait a moment before recompiling.`,
    );
    this.name = 'CompileRateLimitExceededError';
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
      waitingTenants: this.queues.size,
    };
  }

  public tryAcquire(): (() => void) | null {
    if (this.active < this.capacity && this.waiting === 0) {
      this.active++;
      return this.makeRelease();
    }
    return null;
  }

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
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      };

      const waiter: Waiter = {
        key,
        cleanup,
        reject: (err: Error) => {
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

  private removeWaiter(waiter: Waiter): boolean {
    const q = this.queues.get(waiter.key);
    if (!q) return false;
    const idx = q.indexOf(waiter);
    if (idx === -1) return false;
    q.splice(idx, 1);
    this.waiting--;
    if (q.length === 0) {
      this.dropTenant(waiter.key);
    }
    return true;
  }

  private dropTenant(key: string): void {
    this.queues.delete(key);
    const idx = this.ring.indexOf(key);
    if (idx !== -1) {
      this.ring.splice(idx, 1);
      if (this.cursor >= this.ring.length) {
        this.cursor = 0;
      }
    }
  }

  private dispatch(): void {
    while (
      this.active < this.capacity &&
      this.waiting > 0 &&
      this.ring.length > 0
    ) {
      const key = this.ring[this.cursor % this.ring.length];
      const q = this.queues.get(key);
      if (!q || q.length === 0) {
        this.dropTenant(key);
        continue;
      }

      const waiter = q.shift()!;
      this.waiting--;
      this.active++;

      if (q.length === 0) {
        this.dropTenant(key);
      } else {
        this.cursor = (this.cursor + 1) % this.ring.length;
      }
      waiter.grant();
    }
  }
}
