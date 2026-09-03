import { Injectable, Logger } from '@nestjs/common';
import {
  MetadataProvider,
  MetadataRequest,
  ProviderExecutionResult,
  ProviderExecutionStatus,
  ProviderName,
} from '../types/metadata.types';

function toAbortError(reason: unknown, fallbackMessage: string): Error {
  if (reason instanceof Error) return reason;
  return new Error(typeof reason === 'string' ? reason : fallbackMessage);
}

/**
 * Async Semaphore for bounded concurrency with cancellation support.
 */
export class Semaphore {
  private current = 0;
  private queue: Array<{
    resolve: (release: () => void) => void;
    reject: (err: any) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];

  constructor(public readonly max: number) {}

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      throw signal.reason || new Error('Aborted before acquiring semaphore');
    }

    if (this.current < this.max) {
      this.current++;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          this.current--;
          this.drainQueue();
        }
      };
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: {
        resolve: (release: () => void) => void;
        reject: (err: any) => void;
        signal?: AbortSignal;
        onAbort?: () => void;
      } = {
        resolve,
        reject,
        signal,
      };

      if (signal) {
        waiter.onAbort = () => {
          const index = this.queue.indexOf(waiter);
          if (index !== -1) {
            this.queue.splice(index, 1);
          }
          reject(
            toAbortError(
              signal.reason,
              'Aborted while waiting in concurrency queue',
            ),
          );
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }

      this.queue.push(waiter);
    });
  }

  private drainQueue(): void {
    while (this.queue.length > 0 && this.current < this.max) {
      const waiter = this.queue.shift();
      if (!waiter) break;

      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      }

      if (waiter.signal?.aborted) {
        waiter.reject(
          toAbortError(
            waiter.signal.reason,
            'Aborted while waiting in concurrency queue',
          ),
        );
        continue;
      }

      this.current++;
      let released = false;
      const releaseFn = () => {
        if (!released) {
          released = true;
          this.current--;
          this.drainQueue();
        }
      };

      waiter.resolve(releaseFn);
      break;
    }
  }

  async runWith<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  get activeCount(): number {
    return this.current;
  }

  get waitingCount(): number {
    return this.queue.length;
  }
}

/**
 * Error with structured metadata details from HTTP fetch.
 */
export class ProviderFetchError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly retryAfterMs?: number,
    public readonly isTimeout?: boolean,
    public readonly isParseError?: boolean,
  ) {
    super(message);
    this.name = ProviderFetchError.name;
  }
}

@Injectable()
export class ProviderExecutor {
  public static readonly MAX_RETRY_AFTER_MS = 5000;

  private readonly logger = new Logger(ProviderExecutor.name);
  private readonly globalSemaphore = new Semaphore(10);
  private readonly providerSemaphores = new Map<ProviderName, Semaphore>();

  private getProviderSemaphore(provider: MetadataProvider): Semaphore {
    let sem = this.providerSemaphores.get(provider.id);
    if (!sem) {
      sem = new Semaphore(provider.capabilities.maxConcurrency || 2);
      this.providerSemaphores.set(provider.id, sem);
    }
    return sem;
  }

  /**
   * Executes a single provider with:
   * 1. Concurrency slot acquisition (global and provider) with caller signal cancellation
   * 2. Provider timeout starting ONLY AFTER concurrency slot is acquired
   * 3. Provider invocation
   * 4. Timer and event listener cleanup
   * 5. Semaphore release BEFORE sleep/backoff
   * 6. Sleep backoff (without holding semaphore)
   * 7. Retry attempt acquiring fresh slot
   */
  async execute(
    provider: MetadataProvider,
    request: MetadataRequest,
    callerSignal?: AbortSignal,
  ): Promise<ProviderExecutionResult> {
    const timeoutMs = provider.capabilities.timeoutMs || 8000;
    const providerSem = this.getProviderSemaphore(provider);
    const maxRetries = 2;
    const startTime = Date.now();

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (callerSignal?.aborted) {
        return {
          provider: provider.id,
          status: 'timeout',
          error: 'Caller aborted before request started',
          durationMs: Date.now() - startTime,
        };
      }

      let execResult: ProviderExecutionResult | null = null;
      let shouldRetry = false;
      let retryDelay = 0;
      let retryStatus: ProviderExecutionStatus = 'unavailable';

      let releaseGlobal: (() => void) | undefined;
      let releaseProvider: (() => void) | undefined;

      try {
        // 1. Wait for concurrency slots (global then provider)
        releaseGlobal = await this.globalSemaphore.acquire(callerSignal);
        try {
          releaseProvider = await providerSem.acquire(callerSignal);
        } catch (err) {
          if (releaseGlobal) {
            releaseGlobal();
            releaseGlobal = undefined;
          }
          throw err;
        }

        // 2. AFTER acquiring slots: start provider timeout and setup merged abort controller
        const controller = new AbortController();
        let timedOut = false;

        const timeoutId = setTimeout(() => {
          timedOut = true;
          controller.abort(new Error(`Timeout after ${timeoutMs}ms`));
        }, timeoutMs);

        const onCallerAbort = () => {
          controller.abort(callerSignal?.reason || new Error('Caller aborted'));
        };

        if (callerSignal) {
          callerSignal.addEventListener('abort', onCallerAbort, { once: true });
        }

        try {
          // 3. Call provider
          const result = await provider.resolve(request, controller.signal);

          if (result) {
            execResult = {
              provider: provider.id,
              status: 'found',
              result,
              durationMs: Date.now() - startTime,
            };
          } else {
            execResult = {
              provider: provider.id,
              status: 'not_found',
              result: null,
              durationMs: Date.now() - startTime,
            };
          }
        } catch (err: any) {
          const isTimeout =
            timedOut ||
            err?.isTimeout ||
            err?.name === 'AbortError' ||
            err?.name === 'TimeoutError' ||
            /timeout/i.test(err?.message || '');

          const statusCode =
            err?.statusCode || err?.status || err?.response?.status;
          const rawRetryAfter = this.parseRetryAfter(
            err?.headers?.['retry-after'],
          );
          const retryAfterMs = err?.retryAfterMs ?? rawRetryAfter;

          const status = this.classifyError(err, isTimeout, statusCode);

          const isRetryable =
            (status === 'timeout' ||
              status === 'rate_limited' ||
              status === 'unavailable' ||
              statusCode === 408) &&
            !callerSignal?.aborted;

          if (isRetryable && attempt < maxRetries) {
            shouldRetry = true;
            retryStatus = status;
            retryDelay =
              retryAfterMs && retryAfterMs > 0
                ? Math.min(retryAfterMs, ProviderExecutor.MAX_RETRY_AFTER_MS)
                : status === 'rate_limited'
                  ? Math.min(
                      1200 * Math.pow(1.5, attempt),
                      ProviderExecutor.MAX_RETRY_AFTER_MS,
                    )
                  : Math.min(200 * Math.pow(2, attempt), 2000);
          } else {
            this.logger.warn(
              JSON.stringify({
                event: 'library.metadata.provider_execution',
                provider: provider.id,
                status,
                attempt,
                durationMs: Date.now() - startTime,
                statusCode,
              }),
            );
            execResult = {
              provider: provider.id,
              status,
              error: err?.message || String(err),
              statusCode,
              retryAfterMs,
              durationMs: Date.now() - startTime,
            };
          }
        } finally {
          // 4. Cleanup timer and listener
          clearTimeout(timeoutId);
          if (callerSignal) {
            callerSignal.removeEventListener('abort', onCallerAbort);
          }
        }
      } catch (queueErr: any) {
        if (callerSignal?.aborted) {
          return {
            provider: provider.id,
            status: 'timeout',
            error: 'Caller aborted while waiting for concurrency slot',
            durationMs: Date.now() - startTime,
          };
        }
        return {
          provider: provider.id,
          status: 'unavailable',
          error: queueErr?.message || String(queueErr),
          durationMs: Date.now() - startTime,
        };
      } finally {
        // 5. Release semaphore BEFORE backoff sleep!
        if (releaseProvider) {
          releaseProvider();
          releaseProvider = undefined;
        }
        if (releaseGlobal) {
          releaseGlobal();
          releaseGlobal = undefined;
        }
      }

      if (execResult) {
        return execResult;
      }

      if (shouldRetry) {
        // 6. After semaphore release: perform retry backoff
        this.logger.debug(
          JSON.stringify({
            event: 'library.metadata.provider_retry',
            provider: provider.id,
            status: retryStatus,
            retryCount: attempt + 1,
            maxRetries,
            retryDelayMs: retryDelay,
          }),
        );
        try {
          await this.sleep(retryDelay, callerSignal);
        } catch {
          return {
            provider: provider.id,
            status: 'timeout',
            error: 'Caller aborted during provider retry backoff',
            durationMs: Date.now() - startTime,
          };
        }
        // 7. Next loop iteration will acquire new slots from scratch
      }
    }

    return {
      provider: provider.id,
      status: 'unavailable',
      error: 'Max retries exhausted',
      durationMs: Date.now() - startTime,
    };
  }

  private classifyError(
    err: any,
    isTimeout: boolean,
    statusCode?: number,
  ): ProviderExecutionStatus {
    if (isTimeout) return 'timeout';

    if (statusCode === 404) return 'not_found';
    if (statusCode === 429 || /rate\s*limit/i.test(err?.message || ''))
      return 'rate_limited';
    if (statusCode === 401 || statusCode === 403) return 'configuration_error';
    if (statusCode && statusCode >= 500 && statusCode < 600) {
      return 'unavailable';
    }
    if (err?.isParseError || err instanceof SyntaxError)
      return 'invalid_payload';
    if (
      /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|network error/i.test(
        err?.message || '',
      )
    ) {
      return 'unavailable';
    }

    if (statusCode === 400) return 'invalid_payload';

    return 'unavailable';
  }

  private parseRetryAfter(headerValue?: string): number | undefined {
    if (!headerValue) return undefined;
    const trimmed = headerValue.trim();
    const seconds = parseInt(trimmed, 10);
    if (!isNaN(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
    const dateMs = Date.parse(trimmed);
    if (!isNaN(dateMs)) {
      const diff = dateMs - Date.now();
      return diff > 0 ? diff : 0;
    }
    return undefined;
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(
        toAbortError(signal.reason, 'Caller aborted during retry backoff'),
      );
    }

    return new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timeoutId);
        reject(
          toAbortError(signal?.reason, 'Caller aborted during retry backoff'),
        );
      };
      const timeoutId = setTimeout(() => {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);

      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
