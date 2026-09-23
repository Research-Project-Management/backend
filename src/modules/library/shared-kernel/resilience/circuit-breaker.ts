import { Logger } from '@nestjs/common';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  name?: string;
  failureThreshold?: number;
  resetTimeoutMs?: number;
  halfOpenMaxAttempts?: number;
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

export class CircuitBreakerOpenError extends Error {
  constructor(
    public readonly breakerName: string,
    public readonly resetTimeoutMs: number,
  ) {
    super(
      `Circuit breaker for "${breakerName}" is OPEN. Requests are temporarily short-circuited.`,
    );
    this.name = 'CircuitBreakerOpenError';
  }
}

/**
 * Enterprise Resilient Circuit Breaker.
 *
 * Protects downstream systems and the host application against cascading failures:
 * - CLOSED: Normal operation. All requests pass through.
 * - OPEN: Outage detected. Fast-fails immediately (0ms) without issuing network requests.
 * - HALF_OPEN: Cooldown expired. Allows a controlled probe request to check if the remote service has recovered.
 */
export class CircuitBreaker {
  private readonly logger = new Logger(CircuitBreaker.name);
  private state: CircuitState = 'CLOSED';
  private consecutiveFailures = 0;
  private lastFailureTime = 0;
  private halfOpenAttempts = 0;

  public readonly name: string;
  public readonly failureThreshold: number;
  public readonly resetTimeoutMs: number;
  public readonly halfOpenMaxAttempts: number;
  private readonly onStateChange?: (from: CircuitState, to: CircuitState) => void;

  constructor(options: CircuitBreakerOptions = {}) {
    this.name = options.name || 'default';
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 30000;
    this.halfOpenMaxAttempts = options.halfOpenMaxAttempts ?? 1;
    this.onStateChange = options.onStateChange;
  }

  public getState(): CircuitState {
    if (this.state === 'OPEN') {
      const now = Date.now();
      if (now - this.lastFailureTime >= this.resetTimeoutMs) {
        this.transitionTo('HALF_OPEN');
        this.halfOpenAttempts = 0;
      }
    }
    return this.state;
  }

  public canExecute(): boolean {
    const currentState = this.getState();

    if (currentState === 'CLOSED') {
      return true;
    }

    if (currentState === 'HALF_OPEN') {
      if (this.halfOpenAttempts < this.halfOpenMaxAttempts) {
        this.halfOpenAttempts++;
        return true;
      }
      return false;
    }

    // OPEN state: fast-fail
    return false;
  }

  public recordSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      this.logger.log(
        `[CircuitBreaker:${this.name}] Probe request succeeded. Closing circuit (Service recovered).`,
      );
      this.transitionTo('CLOSED');
    }
    this.consecutiveFailures = 0;
    this.halfOpenAttempts = 0;
  }

  public recordFailure(isOutage = true): void {
    if (!isOutage) return;

    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();

    if (this.state === 'HALF_OPEN') {
      this.logger.warn(
        `[CircuitBreaker:${this.name}] Probe request failed in HALF_OPEN. Re-opening circuit for ${this.resetTimeoutMs}ms.`,
      );
      this.transitionTo('OPEN');
      return;
    }

    if (this.consecutiveFailures >= this.failureThreshold) {
      this.logger.error(
        `[CircuitBreaker:${this.name}] Failure threshold reached (${this.consecutiveFailures}/${this.failureThreshold}). Circuit OPENED for ${this.resetTimeoutMs}ms.`,
      );
      this.transitionTo('OPEN');
    }
  }

  public async execute<T>(
    fn: () => Promise<T>,
    fallback?: (err: Error) => Promise<T>,
  ): Promise<T> {
    if (!this.canExecute()) {
      const openErr = new CircuitBreakerOpenError(
        this.name,
        this.resetTimeoutMs,
      );
      if (fallback) {
        return fallback(openErr);
      }
      throw openErr;
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (err: any) {
      this.recordFailure(true);
      if (fallback) {
        return fallback(err);
      }
      throw err;
    }
  }

  public reset(): void {
    this.state = 'CLOSED';
    this.consecutiveFailures = 0;
    this.lastFailureTime = 0;
    this.halfOpenAttempts = 0;
  }

  private transitionTo(newState: CircuitState): void {
    if (this.state === newState) return;
    const oldState = this.state;
    this.state = newState;
    if (this.onStateChange) {
      try {
        this.onStateChange(oldState, newState);
      } catch {
        // Safe callback execution
      }
    }
  }
}
