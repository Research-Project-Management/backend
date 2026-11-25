/**
 * modules/bff/bff.resilience.ts
 * O(1) per-section Circuit Breaker (CLOSED -> OPEN -> HALF_OPEN with single-probe lock),
 * leak-free timeout enforcement, and graceful partial degradation.
 */

import { Logger } from '@nestjs/common';

export const DEFAULT_BFF_SECTION_TIMEOUT_MS = 2_500;
export const DEFAULT_CIRCUIT_FAILURE_THRESHOLD = 3;
export const DEFAULT_CIRCUIT_COOLDOWN_MS = 30_000;

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface BffSectionOutcome<T> {
  section: string;
  value: T;
  degraded: boolean;
  timedOut: boolean;
  circuitOpen: boolean;
}

interface CircuitRecord {
  state: CircuitState;
  consecutiveFailures: number;
  openedAt: number;
  halfOpenInFlight: boolean;
}

export class BffSectionTimeoutError extends Error {
  constructor(
    public readonly section: string,
    public readonly timeoutMs: number,
  ) {
    super(`BFF section "${section}" exceeded ${timeoutMs}ms timeout`);
    this.name = 'BffSectionTimeoutError';
  }
}

export class BffSectionCircuitBreaker {
  private readonly circuits = new Map<string, CircuitRecord>();

  constructor(
    private readonly failureThreshold = DEFAULT_CIRCUIT_FAILURE_THRESHOLD,
    private readonly cooldownMs = DEFAULT_CIRCUIT_COOLDOWN_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Pure read-only effective state (never mutates internal records). */
  private computeEffectiveState(record: CircuitRecord): CircuitState {
    if (
      record.state === 'OPEN' &&
      this.now() - record.openedAt >= this.cooldownMs
    ) {
      return 'HALF_OPEN';
    }
    return record.state;
  }

  getState(section: string): CircuitState {
    const record = this.circuits.get(section);
    if (!record) return 'CLOSED';
    return this.computeEffectiveState(record);
  }

  /**
   * Acquires execution permission for a section.
   * When HALF_OPEN, allows exactly ONE canary probe (`halfOpenInFlight = true`)
   * and fails-fast all other concurrent callers to prevent a thundering herd.
   */
  tryAcquire(section: string): boolean {
    const record = this.circuits.get(section);
    if (!record) return true;

    const effective = this.computeEffectiveState(record);
    if (effective === 'CLOSED') return true;
    if (effective === 'OPEN') return false;

    // HALF_OPEN: allow only 1 concurrent probe
    if (record.halfOpenInFlight) {
      return false;
    }

    record.state = 'HALF_OPEN';
    record.halfOpenInFlight = true;
    return true;
  }

  recordSuccess(section: string): void {
    this.circuits.delete(section);
  }

  recordFailure(section: string): CircuitState {
    const current = this.circuits.get(section) ?? {
      state: 'CLOSED' as CircuitState,
      consecutiveFailures: 0,
      openedAt: 0,
      halfOpenInFlight: false,
    };

    const effective = this.computeEffectiveState(current);
    if (effective === 'HALF_OPEN') {
      current.state = 'OPEN';
      current.openedAt = this.now();
      current.consecutiveFailures = this.failureThreshold;
      current.halfOpenInFlight = false;
      this.circuits.set(section, current);
      return current.state;
    }

    current.consecutiveFailures += 1;
    current.halfOpenInFlight = false;
    if (current.consecutiveFailures >= this.failureThreshold) {
      current.state = 'OPEN';
      current.openedAt = this.now();
    }

    this.circuits.set(section, current);
    return current.state;
  }

  /** Pure read-only observability snapshot. */
  getStats(): Array<{
    section: string;
    state: CircuitState;
    consecutiveFailures: number;
    halfOpenInFlight: boolean;
  }> {
    const stats: Array<{
      section: string;
      state: CircuitState;
      consecutiveFailures: number;
      halfOpenInFlight: boolean;
    }> = [];
    for (const [section, record] of this.circuits.entries()) {
      stats.push({
        section,
        state: this.computeEffectiveState(record),
        consecutiveFailures: record.consecutiveFailures,
        halfOpenInFlight: record.halfOpenInFlight,
      });
    }
    return stats;
  }
}

export async function runWithTimeout<T>(
  section: string,
  loader: () => Promise<T>,
  timeoutMs = DEFAULT_BFF_SECTION_TIMEOUT_MS,
): Promise<T> {
  if (timeoutMs <= 0) {
    return loader();
  }

  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new BffSectionTimeoutError(section, timeoutMs));
    }, timeoutMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  });

  try {
    return await Promise.race([loader(), timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function settleOptionalSection<T>(
  section: string,
  loader: () => Promise<T>,
  fallback: T,
  options?: {
    timeoutMs?: number;
    logger?: Logger;
    circuitBreaker?: BffSectionCircuitBreaker;
  },
): Promise<BffSectionOutcome<T>> {
  const breaker = options?.circuitBreaker;

  if (breaker && !breaker.tryAcquire(section)) {
    return {
      section,
      value: fallback,
      degraded: true,
      timedOut: false,
      circuitOpen: true,
    };
  }

  const timeoutMs = options?.timeoutMs ?? DEFAULT_BFF_SECTION_TIMEOUT_MS;

  try {
    const value = await runWithTimeout(section, loader, timeoutMs);
    breaker?.recordSuccess(section);
    return {
      section,
      value,
      degraded: false,
      timedOut: false,
      circuitOpen: false,
    };
  } catch (err: unknown) {
    const nextState = breaker?.recordFailure(section);
    const timedOut = err instanceof BffSectionTimeoutError;
    const msg = err instanceof Error ? err.message : String(err);
    options?.logger?.warn(
      `BFF optional section "${section}" ${timedOut ? 'timed out' : 'degraded'}` +
        `${nextState === 'OPEN' ? ' (circuit OPEN)' : ''}: ${msg}`,
    );
    return {
      section,
      value: fallback,
      degraded: true,
      timedOut,
      circuitOpen: nextState === 'OPEN',
    };
  }
}

export function summarizeSectionOutcomes(
  outcomes: ReadonlyArray<
    Pick<
      BffSectionOutcome<unknown>,
      'section' | 'degraded' | 'timedOut' | 'circuitOpen'
    >
  >,
): {
  degradedSections: string[];
  timedOutSections: string[];
  circuitOpenSections: string[];
  partial: boolean;
} {
  const degradedSections: string[] = [];
  const timedOutSections: string[] = [];
  const circuitOpenSections: string[] = [];

  for (const outcome of outcomes) {
    if (outcome.degraded) degradedSections.push(outcome.section);
    if (outcome.timedOut) timedOutSections.push(outcome.section);
    if (outcome.circuitOpen) circuitOpenSections.push(outcome.section);
  }

  return {
    degradedSections,
    timedOutSections,
    circuitOpenSections,
    partial: degradedSections.length > 0,
  };
}
