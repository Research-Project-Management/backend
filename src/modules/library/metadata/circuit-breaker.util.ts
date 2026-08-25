import { Logger } from '@nestjs/common';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  failureThreshold?: number; // Number of failures before tripping circuit (default: 3)
  cooldownMs?: number; // How long to stay in OPEN state before trying HALF_OPEN (default: 30,000ms)
}

interface ProviderCircuitRecord {
  state: CircuitState;
  failureCount: number;
  lastFailureTime: number;
  lastStateChange: number;
}

/**
 * In-memory Provider Circuit Breaker for Academic APIs.
 * Prevents cascading timeouts and latency spikes when external services (e.g. CrossRef, S2) are degraded.
 */
export class ProviderCircuitBreaker {
  private readonly logger = new Logger(ProviderCircuitBreaker.name);
  private readonly records = new Map<string, ProviderCircuitRecord>();
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;

  constructor(options?: CircuitBreakerOptions) {
    this.failureThreshold = options?.failureThreshold ?? 3;
    this.cooldownMs = options?.cooldownMs ?? 30_000; // 30 seconds cooldown
  }

  private getRecord(provider: string): ProviderCircuitRecord {
    let rec = this.records.get(provider);
    if (!rec) {
      rec = {
        state: 'CLOSED',
        failureCount: 0,
        lastFailureTime: 0,
        lastStateChange: Date.now(),
      };
      this.records.set(provider, rec);
    }
    return rec;
  }

  /**
   * Checks if an execution is allowed for the given provider.
   */
  canExecute(provider: string): boolean {
    const rec = this.getRecord(provider);
    const now = Date.now();

    if (rec.state === 'CLOSED') {
      return true;
    }

    if (rec.state === 'OPEN') {
      if (now - rec.lastFailureTime >= this.cooldownMs) {
        rec.state = 'HALF_OPEN';
        rec.lastStateChange = now;
        this.logger.log(
          `Circuit for "${provider}" transitioned to HALF_OPEN (testing recovery)`,
        );
        return true;
      }
      return false;
    }

    if (rec.state === 'HALF_OPEN') {
      return true;
    }

    return true;
  }

  /**
   * Records a successful execution and resets the circuit to CLOSED.
   */
  recordSuccess(provider: string): void {
    const rec = this.getRecord(provider);
    if (rec.state !== 'CLOSED') {
      this.logger.log(`Circuit for "${provider}" recovered -> CLOSED`);
    }
    rec.state = 'CLOSED';
    rec.failureCount = 0;
    rec.lastStateChange = Date.now();
  }

  /**
   * Records a failed execution and trips the circuit to OPEN if threshold is exceeded.
   */
  recordFailure(provider: string, error?: unknown): void {
    const rec = this.getRecord(provider);
    const now = Date.now();
    rec.failureCount += 1;
    rec.lastFailureTime = now;

    if (rec.state === 'CLOSED' && rec.failureCount >= this.failureThreshold) {
      rec.state = 'OPEN';
      rec.lastStateChange = now;
      this.logger.warn(
        `Circuit for "${provider}" TRIPPED to OPEN after ${rec.failureCount} consecutive failures (cooldown: ${this.cooldownMs / 1000}s). Error: ${error instanceof Error ? error.message : String(error)}`,
      );
    } else if (rec.state === 'HALF_OPEN') {
      rec.state = 'OPEN';
      rec.lastStateChange = now;
      this.logger.warn(
        `Circuit for "${provider}" reopened after trial request failed.`,
      );
    }
  }

  /**
   * Executes an async fetcher call through the circuit breaker protection.
   */
  async execute<T>(
    provider: string,
    operation: () => Promise<T | null>,
  ): Promise<T | null> {
    if (!this.canExecute(provider)) {
      this.logger.debug(
        `Circuit OPEN for provider "${provider}" — fast-failing to secondary provider`,
      );
      return null;
    }

    try {
      const result = await operation();
      if (result !== null && result !== undefined) {
        this.recordSuccess(provider);
      }
      return result;
    } catch (err) {
      this.recordFailure(provider, err);
      return null;
    }
  }
}
