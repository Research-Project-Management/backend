import { DomainRateLimiterService } from '@/modules/library/ingestion/services/domain-rate-limiter.service';

describe('DomainRateLimiterService', () => {
  let service: DomainRateLimiterService;

  beforeEach(() => {
    service = new DomainRateLimiterService();
  });

  afterEach(() => {
    service.reset();
  });

  it('normalizes domain keys correctly', () => {
    expect(service.normalizeKey('https://export.arxiv.org/api')).toBe(
      'export.arxiv.org/api',
    );
    expect(service.normalizeKey('export.arxiv.org:443')).toBe(
      'export.arxiv.org',
    );
    expect(service.normalizeKey('ARXIV')).toBe('arxiv');
  });

  it('provides domain specific rate limits', () => {
    expect(service.getConfig('export.arxiv.org').minIntervalMs).toBe(3000);
    expect(service.getConfig('arxiv').minIntervalMs).toBe(3000);
    expect(service.getConfig('eutils.ncbi.nlm.nih.gov').minIntervalMs).toBe(
      350,
    );
    expect(service.getConfig('pubmed').minIntervalMs).toBe(350);
    expect(service.getConfig('dblp.org').minIntervalMs).toBe(250);
    expect(service.getConfig('api.semanticscholar.org').minIntervalMs).toBe(
      200,
    );
    expect(service.getConfig('unknown-domain.org').minIntervalMs).toBe(50);
  });

  it('enforces delay between consecutive calls to the same domain', async () => {
    // Override config for fast unit testing
    (service as any).domainConfigs['test-domain'] = { minIntervalMs: 80 };

    const t0 = Date.now();
    await service.acquire('test-domain');
    const t1 = Date.now();
    expect(t1 - t0).toBeLessThan(30); // First call should not wait

    await service.acquire('test-domain');
    const t2 = Date.now();
    expect(t2 - t1).toBeGreaterThanOrEqual(70); // Second call should wait ~80ms
  });

  it('does not block different domains from executing concurrently', async () => {
    (service as any).domainConfigs['domain-a'] = { minIntervalMs: 150 };
    (service as any).domainConfigs['domain-b'] = { minIntervalMs: 150 };

    const t0 = Date.now();
    await service.acquire('domain-a');
    await service.acquire('domain-b');
    const elapsed = Date.now() - t0;

    // Both calls to distinct domains should run immediately without blocking each other
    expect(elapsed).toBeLessThan(50);
  });

  it('respects bypassDelay flag', async () => {
    service.setDomainConfig('slow-domain', { minIntervalMs: 500 });
    service.bypassDelay = true;

    const t0 = Date.now();
    await service.acquire('slow-domain');
    await service.acquire('slow-domain');
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(150);
  });

  it('aborts cleanly when AbortSignal is triggered', async () => {
    service.setDomainConfig('abort-domain', { minIntervalMs: 500 });

    await service.acquire('abort-domain');

    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('User aborted')), 20);

    await expect(
      service.acquire('abort-domain', controller.signal),
    ).rejects.toThrow('User aborted');
  });

  it('executes tasks via schedule wrapper', async () => {
    (service as any).domainConfigs['task-domain'] = { minIntervalMs: 20 };

    const result = await service.schedule('task-domain', async () => {
      return 42;
    });

    expect(result).toBe(42);
  });
});
