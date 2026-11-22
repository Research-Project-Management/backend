/**
 * modules/manuscripts/clsi/domain/fair-semaphore.ts
 * Pure Domain: Per-Tenant Fair Semaphore & Domain Errors for LaTeX compilation.
 * 100% Pure TypeScript, zero framework dependencies.
 */

import { PagesDomainError } from '@/modules/pages/core/domain/pages-domain.error';

export class SemaphoreQueueFullError extends PagesDomainError {
  constructor(public readonly maxQueue: number) {
    super(`Compile queue is full (${maxQueue} waiting)`, {
      code: 'COMPILE_QUEUE_FULL',
      statusCode: 503,
    });
  }
}

export class SemaphoreWaitTimeoutError extends PagesDomainError {
  constructor(public readonly waitedMs: number) {
    super(`Timed out after ${waitedMs}ms waiting for a compile slot`, {
      code: 'COMPILE_QUEUE_TIMEOUT',
      statusCode: 504,
    });
  }
}

export class SemaphoreAbortedError extends PagesDomainError {
  constructor() {
    super('Wait for compile slot aborted', {
      code: 'COMPILE_ABORTED',
      statusCode: 499,
    });
  }
}

export class CompileRateLimitExceededError extends PagesDomainError {
  constructor(public readonly maxPerMinute: number) {
    super(
      `Compilation rate limit exceeded (${maxPerMinute} runs/min). Please wait a moment before recompiling.`,
      {
        code: 'COMPILE_RATE_LIMITED',
        statusCode: 429,
      },
    );
  }
}

export class AutoCompileShedError extends PagesDomainError {
  constructor(
    public readonly waiting: number,
    public readonly threshold: number,
  ) {
    super(
      'Auto-compilation shed under high queue contention to prioritize manual builds',
      {
        code: 'AUTO_COMPILE_SHED',
        statusCode: 429,
      },
    );
  }
}

export class CompileSupersededError extends PagesDomainError {
  constructor(message = 'Compilation superseded by a newer request') {
    super(message, {
      code: 'COMPILE_SUPERSEDED',
      statusCode: 409,
    });
  }
}

export type CompilePriority = 'manual' | 'auto';

export interface SemaphoreStats {
  capacity: number;
  active: number;
  waiting: number;
  waitingTenants: number;
  waitingManual?: number;
  waitingAuto?: number;
}

interface Waiter {
  key: string;
  seq: number;
  priority: CompilePriority;
  grant: () => void;
  reject: (err: Error) => void;
  cleanup: () => void;
}

interface PriorityRing {
  readonly queues: Map<string, Waiter[]>;
  readonly ring: string[];
  cursor: number;
}

export class FairSemaphore {
  private active = 0;
  private waiting = 0;
  private nextSeq = 0;
  private readonly manualRing: PriorityRing = {
    queues: new Map<string, Waiter[]>(),
    ring: [],
    cursor: 0,
  };
  private readonly autoRing: PriorityRing = {
    queues: new Map<string, Waiter[]>(),
    ring: [],
    cursor: 0,
  };

  constructor(
    public readonly capacity: number,
    public readonly maxQueue: number = Number.POSITIVE_INFINITY,
    public readonly maxWaitMs: number = Number.POSITIVE_INFINITY,
  ) {
    if (!(capacity >= 1)) throw new RangeError('capacity must be >= 1');
  }

  public stats(): SemaphoreStats {
    const tenants = new Set<string>([
      ...this.manualRing.queues.keys(),
      ...this.autoRing.queues.keys(),
    ]);
    let waitingManual = 0;
    for (const q of this.manualRing.queues.values()) {
      waitingManual += q.length;
    }
    let waitingAuto = 0;
    for (const q of this.autoRing.queues.values()) {
      waitingAuto += q.length;
    }
    return {
      capacity: this.capacity,
      active: this.active,
      waiting: this.waiting,
      waitingTenants: tenants.size,
      waitingManual,
      waitingAuto,
    };
  }

  public tryAcquire(): (() => void) | null {
    if (this.active < this.capacity && this.waiting === 0) {
      this.active++;
      return this.makeRelease();
    }
    return null;
  }

  public acquire(
    key: string,
    signal?: AbortSignal,
    priority: CompilePriority = 'manual',
  ): Promise<() => void> {
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
        seq: ++this.nextSeq,
        priority,
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

  /**
   * Promotes an existing queued waiter for `key` from 'auto' to 'manual' priority
   * while preserving its original arrival order (`seq`) relative to other waiters.
   */
  public promoteWaiterToManual(key: string): boolean {
    const autoQ = this.autoRing.queues.get(key);
    if (!autoQ || autoQ.length === 0) return false;

    const waiter = autoQ.shift()!;
    if (autoQ.length === 0) {
      this.dropTenantFromRing(this.autoRing, key);
    }

    waiter.priority = 'manual';
    let manualQ = this.manualRing.queues.get(key);
    if (!manualQ) {
      manualQ = [];
      this.manualRing.queues.set(key, manualQ);
      const insertIdx = this.manualRing.ring.findIndex((otherKey) => {
        const otherHead = this.manualRing.queues.get(otherKey)?.[0];
        return otherHead !== undefined && otherHead.seq > waiter.seq;
      });
      if (insertIdx === -1) {
        this.manualRing.ring.push(key);
      } else {
        this.manualRing.ring.splice(insertIdx, 0, key);
        if (this.manualRing.cursor > insertIdx) {
          this.manualRing.cursor++;
        }
      }
    }
    manualQ.push(waiter);
    return true;
  }

  private getRing(priority: CompilePriority): PriorityRing {
    return priority === 'auto' ? this.autoRing : this.manualRing;
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
    const targetRing = this.getRing(waiter.priority);
    let q = targetRing.queues.get(waiter.key);
    if (!q) {
      q = [];
      targetRing.queues.set(waiter.key, q);
      targetRing.ring.push(waiter.key);
    }
    q.push(waiter);
    this.waiting++;
  }

  private removeWaiter(waiter: Waiter): boolean {
    const targetRing = this.getRing(waiter.priority);
    const q = targetRing.queues.get(waiter.key);
    if (!q) return false;
    const idx = q.indexOf(waiter);
    if (idx === -1) return false;
    q.splice(idx, 1);
    this.waiting--;
    if (q.length === 0) {
      this.dropTenantFromRing(targetRing, waiter.key);
    }
    return true;
  }

  private dropTenantFromRing(targetRing: PriorityRing, key: string): void {
    targetRing.queues.delete(key);
    const idx = targetRing.ring.indexOf(key);
    if (idx !== -1) {
      targetRing.ring.splice(idx, 1);
      if (targetRing.cursor >= targetRing.ring.length) {
        targetRing.cursor = 0;
      }
    }
  }

  private dispatchFromRing(targetRing: PriorityRing): boolean {
    while (targetRing.ring.length > 0) {
      const key = targetRing.ring[targetRing.cursor % targetRing.ring.length];
      const q = targetRing.queues.get(key);
      if (!q || q.length === 0) {
        this.dropTenantFromRing(targetRing, key);
        continue;
      }

      const waiter = q.shift()!;
      this.waiting--;
      this.active++;

      if (q.length === 0) {
        this.dropTenantFromRing(targetRing, key);
      } else {
        targetRing.cursor = (targetRing.cursor + 1) % targetRing.ring.length;
      }
      waiter.grant();
      return true;
    }
    return false;
  }

  private dispatch(): void {
    while (this.active < this.capacity && this.waiting > 0) {
      if (this.dispatchFromRing(this.manualRing)) {
        continue;
      }
      if (this.dispatchFromRing(this.autoRing)) {
        continue;
      }
      break;
    }
  }
}
