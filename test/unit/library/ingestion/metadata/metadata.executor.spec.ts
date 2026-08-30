import {
  ProviderExecutor,
  ProviderFetchError,
  Semaphore,
} from '@/modules/library/ingestion/metadata/services/provider.executor';
import { MetadataProvider } from '@/modules/library/ingestion/metadata/types/metadata.types';

describe('Semaphore', () => {
  it('enforces maximum concurrent executions', async () => {
    const sem = new Semaphore(2);
    let running = 0;
    let maxRunning = 0;

    const task = async (delayMs: number) => {
      await sem.runWith(async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((r) => setTimeout(r, delayMs));
        running--;
      });
    };

    await Promise.all([task(30), task(30), task(30), task(30)]);

    expect(maxRunning).toBe(2);
  });

  it('cancels waiter cleanly when signal aborts in queue', async () => {
    const sem = new Semaphore(1);
    const release1 = await sem.acquire();

    const controller = new AbortController();
    const waitPromise = sem.acquire(controller.signal);

    expect(sem.waitingCount).toBe(1);

    controller.abort(new Error('Cancelled in queue'));

    await expect(waitPromise).rejects.toThrow('Cancelled in queue');
    expect(sem.waitingCount).toBe(0);

    release1();
    expect(sem.activeCount).toBe(0);
  });
});

describe('ProviderExecutor', () => {
  let executor: ProviderExecutor;

  beforeEach(() => {
    executor = new ProviderExecutor();
  });

  function makeMockProvider(
    id = 'CrossRef',
    timeoutMs = 1000,
    resolveFn = jest.fn(),
    maxConcurrency = 2,
  ): MetadataProvider {
    return {
      id: id as any,
      capabilities: {
        queryTypes: ['DOI'],
        isAuthoritative: true,
        timeoutMs,
        maxConcurrency,
      },
      supports: () => true,
      resolve: resolveFn,
    };
  }

  it('returns found status when provider returns result', async () => {
    const mockResult = {
      provider: 'CrossRef' as any,
      metadata: { title: 'Test Paper' },
      confidence: 0.99,
      identifier: '10.1234/test',
      fetchedAt: new Date().toISOString(),
    };
    const provider = makeMockProvider(
      'CrossRef',
      1000,
      jest.fn().mockResolvedValue(mockResult),
    );

    const res = await executor.execute(provider, { query: '10.1234/test' });
    expect(res.status).toBe('found');
    expect(res.result).toEqual(mockResult);
  });

  it('returns not_found status when provider returns null', async () => {
    const provider = makeMockProvider(
      'CrossRef',
      1000,
      jest.fn().mockResolvedValue(null),
    );

    const res = await executor.execute(provider, { query: '10.1234/test' });
    expect(res.status).toBe('not_found');
    expect(res.result).toBeNull();
  });

  it('aborts provider when execution exceeds timeoutMs', async () => {
    const provider = makeMockProvider(
      'CrossRef',
      50, // 50ms timeout
      jest.fn().mockImplementation((req, signal) => {
        return new Promise((resolve, reject) => {
          signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }),
    );

    const res = await executor.execute(provider, { query: '10.1234/test' });
    expect(res.status).toBe('timeout');
  });

  it('timeout timer starts after concurrency queue acquisition, not before', async () => {
    // Fill provider concurrency slots
    const provider = makeMockProvider(
      'CrossRef',
      100, // 100ms provider timeout
      jest.fn().mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 40));
        return {
          provider: 'CrossRef',
          metadata: { title: 'Success After Queue' },
          confidence: 0.99,
          identifier: '10.1234/test',
          fetchedAt: new Date().toISOString(),
        };
      }),
      1, // maxConcurrency: 1
    );

    // Call 1 occupies slot for 120ms
    const slowCall = executor.execute(provider, { query: '10.1234/slow' });
    await new Promise((r) => setTimeout(r, 10));

    // Call 2 waits in queue for 120ms, but its 100ms timeout must NOT expire during queue wait!
    const queuedCall = executor.execute(provider, { query: '10.1234/queued' });

    const [res1, res2] = await Promise.all([slowCall, queuedCall]);
    expect(res1.status).toBe('found');
    expect(res2.status).toBe('found');
    expect(res2.result?.metadata.title).toBe('Success After Queue');
  });

  it('enforces per-provider maxConcurrency', async () => {
    let active = 0;
    let maxActive = 0;

    const provider = makeMockProvider(
      'CrossRef',
      1000,
      jest.fn().mockImplementation(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 50));
        active--;
        return null;
      }),
      2, // maxConcurrency 2
    );

    await Promise.all([
      executor.execute(provider, { query: '10.1234/1' }),
      executor.execute(provider, { query: '10.1234/2' }),
      executor.execute(provider, { query: '10.1234/3' }),
      executor.execute(provider, { query: '10.1234/4' }),
    ]);

    expect(maxActive).toBe(2);
  });

  it('enforces global concurrency across provider executions', async () => {
    let active = 0;
    let maxActive = 0;

    const provider = makeMockProvider(
      'CrossRef',
      1000,
      jest.fn().mockImplementation(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 30));
        active--;
        return null;
      }),
      20,
    );

    await Promise.all(
      Array.from({ length: 15 }, (_, index) =>
        executor.execute(provider, { query: `10.1234/global-${index}` }),
      ),
    );

    expect(maxActive).toBe(10);
  });

  it('releases semaphore slot before backoff sleep on retry', async () => {
    let callCount = 0;

    const provider = makeMockProvider(
      'CrossRef',
      1000,
      jest.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw new ProviderFetchError('Rate limited', 429, 60);
        }
        return {
          provider: 'CrossRef',
          metadata: { title: 'Retried Paper' },
          confidence: 0.99,
          identifier: '10.1234/test',
          fetchedAt: new Date().toISOString(),
        };
      }),
      1, // maxConcurrency 1
    );

    const call1 = executor.execute(provider, { query: '10.1234/call1' });

    // While call1 is in retry backoff, call2 should be able to acquire the slot!
    await new Promise((r) => setTimeout(r, 20));
    const call2 = executor.execute(provider, { query: '10.1234/call2' });

    const [res1, res2] = await Promise.all([call1, call2]);
    expect(res1.status).toBe('found');
    expect(res2.status).toBe('found');
  });

  it('stops retry backoff immediately when the caller aborts', async () => {
    const controller = new AbortController();
    const resolve = jest
      .fn()
      .mockRejectedValue(new ProviderFetchError('Rate limited', 429, 5000));
    const provider = makeMockProvider('CrossRef', 1000, resolve, 1);

    const execution = executor.execute(
      provider,
      { query: '10.1234/abort-backoff' },
      controller.signal,
    );

    await new Promise((r) => setTimeout(r, 20));
    controller.abort(new Error('Caller cancelled'));

    const result = await execution;
    expect(result.status).toBe('timeout');
    expect(result.error).toContain('retry backoff');
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('propagates caller AbortSignal down to running provider', async () => {
    const callerController = new AbortController();
    let providerSignalAborted = false;

    const provider = makeMockProvider(
      'CrossRef',
      5000,
      jest.fn().mockImplementation(async (req, signal) => {
        if (signal?.aborted) providerSignalAborted = true;
        signal?.addEventListener('abort', () => {
          providerSignalAborted = true;
        });
        await new Promise((r) => setTimeout(r, 60));
        return null;
      }),
    );

    const execPromise = executor.execute(
      provider,
      { query: '10.1234/test' },
      callerController.signal,
    );

    await new Promise((r) => setTimeout(r, 10));
    callerController.abort();
    await execPromise;

    expect(providerSignalAborted).toBe(true);
  });

  it('retries on 429 rate limit and respects Retry-After delay (seconds)', async () => {
    let callCount = 0;
    const provider = makeMockProvider(
      'CrossRef',
      2000,
      jest.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw new ProviderFetchError('Rate limited', 429, 50); // 50ms retry after
        }
        return {
          provider: 'CrossRef',
          metadata: { title: 'Recovered' },
          confidence: 0.99,
          identifier: '10.1234/test',
          fetchedAt: new Date().toISOString(),
        };
      }),
    );

    const res = await executor.execute(provider, { query: '10.1234/test' });
    expect(callCount).toBe(2);
    expect(res.status).toBe('found');
    expect(res.result?.metadata.title).toBe('Recovered');
  });

  it('retries on 429 with HTTP Date string header in retry-after', async () => {
    let callCount = 0;
    const futureDate = new Date(Date.now() + 50).toUTCString();

    const provider = makeMockProvider(
      'CrossRef',
      2000,
      jest.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          const err: any = new Error('Rate limited');
          err.statusCode = 429;
          err.headers = { 'retry-after': futureDate };
          throw err;
        }
        return {
          provider: 'CrossRef',
          metadata: { title: 'Recovered via Date' },
          confidence: 0.99,
          identifier: '10.1234/test',
          fetchedAt: new Date().toISOString(),
        };
      }),
    );

    const res = await executor.execute(provider, { query: '10.1234/test' });
    expect(callCount).toBe(2);
    expect(res.status).toBe('found');
    expect(res.result?.metadata.title).toBe('Recovered via Date');
  });

  it('retries on 500 server error up to maxRetries', async () => {
    let callCount = 0;
    const provider = makeMockProvider(
      'CrossRef',
      2000,
      jest.fn().mockImplementation(async () => {
        callCount++;
        throw new ProviderFetchError('Internal server error', 500);
      }),
    );

    const res = await executor.execute(provider, { query: '10.1234/test' });
    expect(callCount).toBe(3); // 1 initial + 2 retries
    expect(res.status).toBe('unavailable');
  });

  it('does NOT retry on 404 Not Found', async () => {
    let callCount = 0;
    const provider = makeMockProvider(
      'CrossRef',
      2000,
      jest.fn().mockImplementation(async () => {
        callCount++;
        throw new ProviderFetchError('Not found', 404);
      }),
    );

    const res = await executor.execute(provider, { query: '10.1234/test' });
    expect(callCount).toBe(1);
    expect(res.status).toBe('not_found');
  });

  it('does NOT retry on 400 Bad Request or invalid payload', async () => {
    let callCount = 0;
    const provider = makeMockProvider(
      'CrossRef',
      2000,
      jest.fn().mockImplementation(async () => {
        callCount++;
        throw new ProviderFetchError('Malformed syntax', 400);
      }),
    );

    const res = await executor.execute(provider, { query: '10.1234/test' });
    expect(callCount).toBe(1);
    expect(res.status).toBe('invalid_payload');
  });

  it('does NOT retry on 401/403 Configuration Error', async () => {
    let callCount = 0;
    const provider = makeMockProvider(
      'CrossRef',
      2000,
      jest.fn().mockImplementation(async () => {
        callCount++;
        throw new ProviderFetchError('Unauthorized', 401);
      }),
    );

    const res = await executor.execute(provider, { query: '10.1234/test' });
    expect(callCount).toBe(1);
    expect(res.status).toBe('configuration_error');
  });
});
