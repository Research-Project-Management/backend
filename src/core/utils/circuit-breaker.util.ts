import { Logger } from '@nestjs/common';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  name: string;
  failureThreshold?: number;
  successThreshold?: number;
  cooldownMs?: number;
}

export class CircuitBreakerOpenException extends Error {
  constructor(name: string, retryAfterMs: number) {
    super(
      `Circuit breaker '${name}' is OPEN. Fast-failing request. Retry after ${Math.ceil(retryAfterMs / 1000)}s.`,
    );
    this.name = 'CircuitBreakerOpenException';
  }
}

/**
 * Lightweight in-memory Circuit Breaker to protect downstream microservices
 * (e.g. CLSI LaTeX Compiler, External SLM/LLM Engine, SearXNG) from cascading failures.
 */
export class CircuitBreaker {
  private readonly name: string;
  private readonly failureThreshold: number;
  private readonly successThreshold: number;
  private readonly cooldownMs: number;
  private readonly logger: Logger;

  private state: CircuitState = 'CLOSED';
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime = 0;

  constructor(options: CircuitBreakerOptions) {
    this.name = options.name;
    this.failureThreshold = options.failureThreshold ?? 3;
    this.successThreshold = options.successThreshold ?? 2;
    this.cooldownMs = options.cooldownMs ?? 15000;
    this.logger = new Logger(`CircuitBreaker(${this.name})`);
  }

  public getState(): CircuitState {
    if (this.state === 'OPEN') {
      const now = Date.now();
      if (now - this.lastFailureTime >= this.cooldownMs) {
        this.state = 'HALF_OPEN';
        this.successCount = 0;
        this.logger.log(
          `Cooldown elapsed. State transition: OPEN -> HALF_OPEN (probing downstream).`,
        );
      }
    }
    return this.state;
  }

  public isOpen(): boolean {
    return this.getState() === 'OPEN';
  }

  public recordSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      this.successCount++;
      if (this.successCount >= this.successThreshold) {
        this.state = 'CLOSED';
        this.failureCount = 0;
        this.successCount = 0;
        this.logger.log(
          `Success threshold reached. State transition: HALF_OPEN -> CLOSED (recovered).`,
        );
      }
    } else if (this.state === 'CLOSED') {
      this.failureCount = 0;
    }
  }

  public recordFailure(err?: unknown): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === 'HALF_OPEN') {
      this.state = 'OPEN';
      this.logger.warn(
        `Probe request failed during HALF_OPEN. State transition: HALF_OPEN -> OPEN. Error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } else if (this.state === 'CLOSED' && this.failureCount >= this.failureThreshold) {
      this.state = 'OPEN';
      this.logger.error(
        `Failure threshold (${this.failureThreshold}) exceeded. State transition: CLOSED -> OPEN. Tripping circuit for ${this.cooldownMs}ms.`,
      );
    }
  }

  public async execute<T>(
    operation: () => Promise<T>,
    fallback?: (error: Error) => Promise<T>,
  ): Promise<T> {
    const currentState = this.getState();

    if (currentState === 'OPEN') {
      const retryAfter = Math.max(
        0,
        this.cooldownMs - (Date.now() - this.lastFailureTime),
      );
      const ex = new CircuitBreakerOpenException(this.name, retryAfter);
      if (fallback) {
        return fallback(ex);
      }
      throw ex;
    }

    try {
      const result = await operation();
      this.recordSuccess();
      return result;
    } catch (err: unknown) {
      const errorObj = err instanceof Error ? err : new Error(String(err));
      this.recordFailure(errorObj);
      if (fallback) {
        return fallback(errorObj);
      }
      throw errorObj;
    }
  }

  public reset(): void {
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = 0;
    this.logger.log(`Circuit breaker manually reset to CLOSED.`);
  }
}
