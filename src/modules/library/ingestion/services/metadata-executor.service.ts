import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  CircuitBreaker,
  ResilienceRegistryService,
} from '@/modules/library/core';
import {
  MetadataProvider,
  MetadataRequest,
  ProviderExecutionResult,
  ProviderExecutionStatus,
  ProviderFetchError,
  ProviderName,
  ProviderResult,
} from '@/modules/library/ingestion/types/metadata.types';
import { normalizeArxivId, normalizeDoi } from '@/modules/library/core';
import { DomainRateLimiterService } from './feed-retrieval.service';

interface BatchableArxivProvider extends MetadataProvider {
  resolveBatch(
    rawIds: string[],
    signal?: AbortSignal,
  ): Promise<Map<string, ProviderResult | null>>;
}

interface BatchableOpenAlexProvider extends MetadataProvider {
  resolveDoiBatch(
    rawDois: string[],
    signal?: AbortSignal,
  ): Promise<Map<string, ProviderResult | null>>;
}

interface PendingMicroBatchItem {
  key: string;
  rawQuery: string;
  resolve: (result: ProviderResult | null) => void;
  reject: (err: unknown) => void;
}

export { ProviderFetchError };

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
    reject: (err: unknown) => void;
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
        reject: (err: unknown) => void;
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

@Injectable()
export class MetadataExecutorService {
  public static readonly MAX_RETRY_AFTER_MS = 5000;
  private static readonly MICRO_BATCH_WINDOW_MS = 35;
  private static readonly MICRO_BATCH_MAX_SIZE = 40;

  private readonly logger = new Logger(MetadataExecutorService.name);
  private readonly globalSemaphore = new Semaphore(10);
  private readonly providerSemaphores = new Map<ProviderName, Semaphore>();
  private readonly pendingMicroBatches = new Map<
    string,
    {
      items: PendingMicroBatchItem[];
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(
    @Optional() private readonly rateLimiter?: DomainRateLimiterService,
    @Optional()
    private readonly resilienceRegistry: ResilienceRegistryService = new ResilienceRegistryService(),
  ) {}

  private canMicroBatch(
    provider: MetadataProvider,
    request: MetadataRequest,
  ): { batchKey: string; itemKey: string } | null {
    if (
      provider.id === 'arXiv' &&
      request.queryType === 'ARXIV' &&
      typeof (provider as BatchableArxivProvider).resolveBatch === 'function'
    ) {
      const clean = normalizeArxivId(request.query) ?? request.query.trim();
      if (clean) {
        return { batchKey: 'arXiv:ARXIV', itemKey: clean.toLowerCase() };
      }
    }
    if (
      provider.id === 'OpenAlex' &&
      request.queryType === 'DOI' &&
      typeof (provider as BatchableOpenAlexProvider).resolveDoiBatch ===
        'function'
    ) {
      const clean = normalizeDoi(request.query);
      if (clean) {
        return { batchKey: 'OpenAlex:DOI', itemKey: clean.toLowerCase() };
      }
    }
    return null;
  }

  private enqueueMicroBatch(
    batchKey: string,
    itemKey: string,
    rawQuery: string,
    provider: MetadataProvider,
    callerSignal?: AbortSignal,
  ): Promise<ProviderResult | null> {
    return new Promise<ProviderResult | null>((resolve, reject) => {
      let bucket = this.pendingMicroBatches.get(batchKey);
      if (!bucket) {
        const timer = setTimeout(() => {
          void this.flushMicroBatch(batchKey, provider);
        }, MetadataExecutorService.MICRO_BATCH_WINDOW_MS);
        bucket = { items: [], timer };
        this.pendingMicroBatches.set(batchKey, bucket);
      }

      bucket.items.push({ key: itemKey, rawQuery, resolve, reject });
      if (
        bucket.items.length >= MetadataExecutorService.MICRO_BATCH_MAX_SIZE
      ) {
        clearTimeout(bucket.timer);
        void this.flushMicroBatch(batchKey, provider);
      } else if (callerSignal?.aborted) {
        clearTimeout(bucket.timer);
        void this.flushMicroBatch(batchKey, provider);
      }
    });
  }

  private async flushMicroBatch(
    batchKey: string,
    provider: MetadataProvider,
  ): Promise<void> {
    const bucket = this.pendingMicroBatches.get(batchKey);
    if (!bucket) return;
    this.pendingMicroBatches.delete(batchKey);
    const items = bucket.items;
    if (items.length === 0) return;

    const timeoutMs = provider.capabilities.timeoutMs || 8000;
    const providerSem = this.getProviderSemaphore(provider);
    let releaseGlobal: (() => void) | undefined;
    let releaseProvider: (() => void) | undefined;

    try {
      releaseGlobal = await this.globalSemaphore.acquire();
      releaseProvider = await providerSem.acquire();

      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort(new Error(`Timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      try {
        if (this.rateLimiter) {
          await this.rateLimiter.acquire(provider.id, controller.signal);
        }

        if (items.length === 1) {
          const singleItem = items[0]!;
          const singleRes = await provider.resolve(
            {
              query: singleItem.rawQuery,
              queryType: batchKey.endsWith(':ARXIV') ? 'ARXIV' : 'DOI',
            },
            controller.signal,
          );
          singleItem.resolve(singleRes);
          return;
        }

        const uniqueQueries = Array.from(
          new Set(items.map((item) => item.rawQuery)),
        );
        const batchResults =
          batchKey === 'arXiv:ARXIV'
            ? await (provider as BatchableArxivProvider).resolveBatch(
                uniqueQueries,
                controller.signal,
              )
            : await (provider as BatchableOpenAlexProvider).resolveDoiBatch(
                uniqueQueries,
                controller.signal,
              );

        for (const item of items) {
          item.resolve(batchResults.get(item.key) ?? null);
        }
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err: unknown) {
      for (const item of items) {
        item.reject(err);
      }
    } finally {
      if (releaseProvider) releaseProvider();
      if (releaseGlobal) releaseGlobal();
    }
  }

  public getCircuitBreaker(providerName: ProviderName): CircuitBreaker {
    return this.resilienceRegistry.getCircuitBreaker(providerName);
  }

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
    const circuitBreaker = this.getCircuitBreaker(provider.id);
    if (!circuitBreaker.peekCanExecute()) {
      this.logger.warn(
        `[CircuitBreaker] Short-circuiting call to provider ${provider.id} (State: ${circuitBreaker.getState()})`,
      );
      return {
        provider: provider.id,
        status: 'unavailable',
        error: `Provider ${provider.id} circuit breaker is OPEN due to repeated outages`,
        durationMs: 0,
      };
    }

    const timeoutMs = provider.capabilities.timeoutMs || 8000;
    const providerSem = this.getProviderSemaphore(provider);
    const maxRetries = 2;
    const startTime = Date.now();
    const microBatchTarget = this.canMicroBatch(provider, request);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (callerSignal?.aborted) {
        return {
          provider: provider.id,
          status: 'timeout',
          error: 'Caller aborted before request started',
          durationMs: Date.now() - startTime,
        };
      }

      if (microBatchTarget && attempt === 0) {
        try {
          const batchedResult = await this.enqueueMicroBatch(
            microBatchTarget.batchKey,
            microBatchTarget.itemKey,
            request.query,
            provider,
            callerSignal,
          );
          circuitBreaker.recordSuccess();
          return batchedResult
            ? {
                provider: provider.id,
                status: 'found',
                result: batchedResult,
                durationMs: Date.now() - startTime,
              }
            : {
                provider: provider.id,
                status: 'not_found',
                result: null,
                durationMs: Date.now() - startTime,
              };
        } catch {
          // Fall back to standard single-item retry loop on batch failure
        }
      }

      let execResult: ProviderExecutionResult | null = null;
      let shouldRetry = false;
      let retryDelay = 0;
      let retryStatus: ProviderExecutionStatus = 'unavailable';
      const attemptFailureSeqBefore =
        typeof circuitBreaker.getFailureSequence === 'function'
          ? circuitBreaker.getFailureSequence()
          : 0;

      let releaseGlobal: (() => void) | undefined;
      let releaseProvider: (() => void) | undefined;

      try {
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
          if (this.rateLimiter) {
            if (
              provider.id === 'arXiv' &&
              typeof this.rateLimiter.peekEstimatedWaitMs === 'function' &&
              this.rateLimiter.peekEstimatedWaitMs(provider.id) > 3500
            ) {
              return {
                provider: provider.id,
                status: 'rate_limited',
                error: 'arXiv GCRA queue saturated (>3.5s wait); fast-failover to high-throughput mirror',
                durationMs: Date.now() - startTime,
              };
            }
            await this.rateLimiter.acquire(provider.id, controller.signal);
          }
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
        } catch (err: unknown) {
          const errRecord =
            err && typeof err === 'object'
              ? (err as Record<string, unknown>)
              : null;
          const errMessage =
            err instanceof Error
              ? err.message
              : typeof errRecord?.message === 'string'
                ? errRecord.message
                : String(err);

          const isTimeout =
            timedOut ||
            Boolean(errRecord?.isTimeout) ||
            errRecord?.name === 'AbortError' ||
            errRecord?.name === 'TimeoutError' ||
            /timeout/i.test(errMessage);

          const statusCode =
            typeof errRecord?.statusCode === 'number'
              ? errRecord.statusCode
              : typeof errRecord?.status === 'number'
                ? errRecord.status
                : typeof (
                      errRecord?.response as { status?: number } | undefined
                    )?.status === 'number'
                  ? (errRecord?.response as { status?: number }).status
                  : undefined;
          const rawRetryAfter = this.parseRetryAfter(
            (
              errRecord?.headers as
                Record<string, string | undefined> | undefined
            )?.['retry-after'],
          );
          const retryAfterMs =
            typeof errRecord?.retryAfterMs === 'number'
              ? errRecord.retryAfterMs
              : rawRetryAfter;

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
                ? Math.min(
                    retryAfterMs,
                    MetadataExecutorService.MAX_RETRY_AFTER_MS,
                  )
                : status === 'rate_limited'
                  ? Math.min(
                      1200 * Math.pow(1.5, attempt),
                      MetadataExecutorService.MAX_RETRY_AFTER_MS,
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
              error: errMessage,
              statusCode,
              retryAfterMs,
              durationMs: Date.now() - startTime,
            };
          }
        } finally {
          clearTimeout(timeoutId);
          if (callerSignal) {
            callerSignal.removeEventListener('abort', onCallerAbort);
          }
        }
      } catch (queueErr: unknown) {
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
          error:
            queueErr instanceof Error ? queueErr.message : String(queueErr),
          durationMs: Date.now() - startTime,
        };
      } finally {
        if (releaseProvider) {
          releaseProvider();
          releaseProvider = undefined;
        }
        if (releaseGlobal) {
          releaseGlobal();
          releaseGlobal = undefined;
        }
      }

      const attemptFailureSeqAfter =
        typeof circuitBreaker.getFailureSequence === 'function'
          ? circuitBreaker.getFailureSequence()
          : 0;
      const alreadyRecordedByInnerBreaker =
        attemptFailureSeqAfter > attemptFailureSeqBefore;

      if (execResult) {
        if (
          execResult.status === 'found' ||
          execResult.status === 'not_found' ||
          execResult.status === 'invalid_payload'
        ) {
          circuitBreaker.recordSuccess();
        } else if (
          (execResult.status === 'unavailable' ||
            execResult.status === 'timeout') &&
          !alreadyRecordedByInnerBreaker
        ) {
          circuitBreaker.recordFailure(true);
        }
        return execResult;
      }

      if (shouldRetry) {
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
      }
    }

    circuitBreaker.recordFailure(true);
    return {
      provider: provider.id,
      status: 'unavailable',
      error: 'Max retries exhausted',
      durationMs: Date.now() - startTime,
    };
  }

  private classifyError(
    err: unknown,
    isTimeout: boolean,
    statusCode?: number,
  ): ProviderExecutionStatus {
    if (isTimeout) return 'timeout';

    const errObj =
      err && typeof err === 'object' ? (err as Record<string, unknown>) : null;
    const errMessage =
      err instanceof Error
        ? err.message
        : typeof errObj?.message === 'string'
          ? errObj.message
          : '';

    if (statusCode === 404 || /\b404\b|not[\s_-]*found/i.test(errMessage)) {
      return 'not_found';
    }
    if (statusCode === 429 || /rate\s*limit/i.test(errMessage))
      return 'rate_limited';
    if (statusCode === 401 || statusCode === 403) return 'configuration_error';
    if (statusCode && statusCode >= 500 && statusCode < 600) {
      return 'unavailable';
    }
    if (Boolean(errObj?.isParseError) || err instanceof SyntaxError)
      return 'invalid_payload';
    if (
      /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|network error/i.test(
        errMessage,
      )
    ) {
      return 'unavailable';
    }

    if (
      statusCode === 400 ||
      statusCode === 422 ||
      /\b(?:400|422)\b|bad[\s_-]*request|invalid.*(?:payload|query|identifier|doi|arxiv|pmid|isbn)/i.test(
        errMessage,
      )
    ) {
      return 'invalid_payload';
    }

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
