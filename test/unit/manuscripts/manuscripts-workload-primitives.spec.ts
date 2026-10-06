/**
 * Unit tests for the manuscripts workload primitives:
 * mapWithConcurrency, FairSemaphore, compile-fileset planner.
 */
import {
  mapWithConcurrency,
  mapSettledWithConcurrency,
} from '@/core/utils/concurrency.util';
import {
  FairSemaphore,
  SemaphoreQueueFullError,
  SemaphoreWaitTimeoutError,
  SemaphoreAbortedError,
} from '@/modules/manuscripts/clsi/core/pipeline/fair-semaphore';
import {
  planDbFileSet,
  planInlineFileSet,
  ManifestDoc,
  ManifestNode,
} from '@/modules/manuscripts/clsi/core/pipeline/compile-fileset';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('mapWithConcurrency', () => {
  it('preserves order and respects the concurrency limit', async () => {
    let running = 0;
    let peak = 0;
    const out = await mapWithConcurrency(
      [1, 2, 3, 4, 5, 6, 7, 8],
      3,
      async (n) => {
        running++;
        peak = Math.max(peak, running);
        await sleep(5 * (9 - n));
        running--;
        return n * 2;
      },
    );
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14, 16]);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it('stops scheduling new items after the first error', async () => {
    const started: number[] = [];
    await expect(
      mapWithConcurrency([1, 2, 3, 4, 5, 6], 1, async (n) => {
        started.push(n);
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
    expect(started).toEqual([1, 2]);
  });

  it('settled variant never rejects', async () => {
    const out = await mapSettledWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('x');
      return n;
    });
    expect(out.map((r) => r.ok)).toEqual([true, false, true]);
  });
});

describe('FairSemaphore', () => {
  it('limits concurrency to capacity', async () => {
    const sem = new FairSemaphore(2);
    const r1 = await sem.acquire('a');
    const r2 = await sem.acquire('a');
    let third = false;
    const p3 = sem.acquire('a').then((r) => {
      third = true;
      return r;
    });
    await sleep(10);
    expect(third).toBe(false);
    r1();
    const r3 = await p3;
    expect(third).toBe(true);
    r2();
    r3();
    expect(sem.stats().active).toBe(0);
  });

  it('serves tenants round-robin (no starvation)', async () => {
    const sem = new FairSemaphore(1);
    const hold = await sem.acquire('seed');
    const order: string[] = [];
    const run = (key: string) =>
      sem.acquire(key).then((rel) => {
        order.push(key);
        rel();
      });
    const ps = [run('A'), run('A'), run('A'), run('B')];
    hold();
    await Promise.all(ps);
    // B must be served before A's third request.
    expect(order.indexOf('B')).toBeLessThan(2);
  });

  it('rejects when the queue is full', async () => {
    const sem = new FairSemaphore(1, 1);
    const hold = await sem.acquire('a');
    const waiting = sem.acquire('a');
    await expect(sem.acquire('b')).rejects.toBeInstanceOf(
      SemaphoreQueueFullError,
    );
    hold();
    (await waiting)();
  });

  it('times out waiters', async () => {
    const sem = new FairSemaphore(1, 10, 20);
    const hold = await sem.acquire('a');
    await expect(sem.acquire('a')).rejects.toBeInstanceOf(
      SemaphoreWaitTimeoutError,
    );
    expect(sem.stats().waiting).toBe(0);
    hold();
  });

  it('removes aborted waiters without consuming a slot', async () => {
    const sem = new FairSemaphore(1);
    const hold = await sem.acquire('a');
    const ac = new AbortController();
    const p = sem.acquire('a', ac.signal);
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(SemaphoreAbortedError);
    expect(sem.stats().waiting).toBe(0);
    hold();
    expect(sem.stats().active).toBe(0);
  });

  it('release is idempotent', async () => {
    const sem = new FairSemaphore(1);
    const rel = await sem.acquire('a');
    rel();
    rel();
    expect(sem.stats().active).toBe(0);
  });
});

describe('compile-fileset planner', () => {
  const t0 = new Date('2026-01-01T00:00:00Z');
  const nodes: ManifestNode[] = [
    {
      id: 'n1',
      docId: 'd1',
      path: '/main.tex',
      name: 'main.tex',
      type: 'DOC',
      isRootDoc: true,
    },
    {
      id: 'n2',
      docId: 'd2',
      path: '/chap/a.tex',
      name: 'a.tex',
      type: 'DOC',
      isRootDoc: false,
    },
    {
      id: 'n3',
      docId: null,
      path: '/chap',
      name: 'chap',
      type: 'FOLDER',
      isRootDoc: false,
    },
  ];
  const docs = (rev = 1, at = t0): ManifestDoc[] => [
    { id: 'd1', path: '/main.tex', rev, sizeBytes: 10, updatedAt: at },
    { id: 'd2', path: '/chap/a.tex', rev: 1, sizeBytes: 5, updatedAt: t0 },
  ];
  const plan = (over: Partial<Parameters<typeof planDbFileSet>[0]> = {}) =>
    planDbFileSet({
      nodes,
      docs: docs(),
      incomingFiles: {},
      source: '',
      mainFile: 'main.tex',
      ...over,
    });

  it('is stable for identical metadata', () => {
    expect(plan().fingerprint).toBe(plan().fingerprint);
  });

  it('changes when rev or updatedAt changes', () => {
    const base = plan().fingerprint;
    expect(plan({ docs: docs(2) }).fingerprint).not.toBe(base);
    expect(
      plan({ docs: docs(1, new Date('2026-02-01T00:00:00Z')) }).fingerprint,
    ).not.toBe(base);
  });

  it('changes when an unsaved override differs', () => {
    const a = plan({ incomingFiles: { d2: 'x' } }).fingerprint;
    const b = plan({ incomingFiles: { d2: 'y' } }).fingerprint;
    expect(a).not.toBe(b);
    expect(a).not.toBe(plan().fingerprint);
  });

  it('detects root doc and strips leading slashes', () => {
    const p = plan();
    expect(p.mainFile).toBe('main.tex');
    expect([...p.files.keys()].sort()).toEqual(['chap/a.tex', 'main.tex']);
    expect(p.hasMainContent).toBe(true);
  });

  it('uses the child page buffer without replacing the main file', () => {
    const p = plan({ pageId: 'd2', source: 'child body' });
    expect(p.files.get('chap/a.tex')?.kind).toBe('inline');
    expect(p.files.get('main.tex')?.kind).toBe('db');
  });

  it('inline plan overlays source when main is empty', () => {
    const p = planInlineFileSet({
      incomingFiles: {},
      source: '\\documentclass{article}',
      mainFile: 'main.tex',
    });
    expect(p.hasMainContent).toBe(true);
    expect(p.files.get('main.tex')?.kind).toBe('inline');
  });
});
