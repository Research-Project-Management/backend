import { ConfigService } from '@nestjs/config';
import { SafePath } from '@/modules/pages/clsi/domain/path.policy';
import { BoundedLruCache } from '@/modules/pages/clsi/domain/lru-cache';
import { UnsafePathException } from '@/modules/pages/clsi/domain/errors';
import { CompileLockService } from '@/modules/pages/clsi/services/compile-lock.service';
import { CompileService } from '@/modules/pages/clsi/services/compile.service';
import { RemoteClsiClientAdapter } from '@/modules/pages/clsi/adapters/remote-clsi.adapter';
import { ClsiMetrics } from '@/modules/pages/clsi/adapters/metrics.adapter';
import type {
  BuildStateRecord,
  ILatexEngine,
  IWorkspaceManager,
} from '@/modules/pages/clsi/domain/ports';

describe('CLSI Production Contract Suite', () => {
  describe('SafePath & BoundedLruCache', () => {
    it('normalizes relative paths and rejects traversal / drive / null bytes', () => {
      expect(SafePath.normalizeRelPath(' ./sections\\intro.tex ')).toBe(
        'sections/intro.tex',
      );
      expect(SafePath.normalizeRelPath('/main.tex')).toBe('main.tex');
      expect(() => SafePath.sanitizeRelativePath('../etc/passwd')).toThrow(
        UnsafePathException,
      );
      expect(() => SafePath.sanitizeRelativePath('C:\\Windows\\win.ini')).toThrow(
        UnsafePathException,
      );
      expect(() => SafePath.sanitizeRelativePath('main.tex\0.pdf')).toThrow(
        UnsafePathException,
      );
    });

    it('evicts least-recently-used entries and refreshes order on get()', () => {
      const cache = new BoundedLruCache<string, number>(2);
      cache.set('a', 1);
      cache.set('b', 2);
      // Access 'a' so 'b' becomes the oldest
      expect(cache.get('a')).toBe(1);
      cache.set('c', 3);

      expect(cache.get('b')).toBeUndefined();
      expect(cache.get('a')).toBe(1);
      expect(cache.get('c')).toBe(3);
      expect(cache.size).toBe(2);
    });
  });

  describe('CompileLockService (Lock, Shedding, Rate Limit, Disconnect Abort, Log Callback)', () => {
    let lockService: CompileLockService;

    beforeEach(() => {
      lockService = new CompileLockService({
        maxConcurrentCompiles: 2,
        autoShedThreshold: 1,
        maxCompilesPerMinute: 10,
        minIntervalBetweenCompilesMs: 0,
        logChunkFlushIntervalMs: 10,
      });
    });

    afterEach(() => {
      lockService.onModuleDestroy();
    });

    it('rejects overlapping compile for same (spaceId, userId) with 423 Locked', async () => {
      let releaseFirst!: () => void;
      const firstDone = new Promise<void>((r) => (releaseFirst = r));

      const first = lockService.runWithLock(
        'page-1',
        'user-1',
        async () => {
          await firstDone;
          return 'ok';
        },
      );

      await expect(
        lockService.runWithLock('page-1', 'user-1', async () => 'second'),
      ).rejects.toMatchObject({ status: 423 });

      releaseFirst();
      expect(await first).toBe('ok');
    });

    it('sheds auto-compile when active compiles reach autoShedThreshold', async () => {
      let releaseFirst!: () => void;
      const firstDone = new Promise<void>((r) => (releaseFirst = r));

      const first = lockService.runWithLock('page-1', 'user-1', async () => {
        await firstDone;
        return 'manual-ok';
      });

      await expect(
        lockService.runWithLock('page-2', 'user-2', async () => 'auto-ok', {
          priority: 'auto',
        }),
      ).rejects.toMatchObject({ status: 429 });

      releaseFirst();
      expect(await first).toBe('manual-ok');
    });

    it('propagates externalSignal (HTTP disconnect) to AbortSignal and invokes onLogFlush', async () => {
      const external = new AbortController();
      const flushedLogs: string[] = [];
      let receivedAborted = false;

      await lockService.runWithLock(
        'page-abort',
        'user-1',
        async (signal) => {
          external.abort();
          receivedAborted = signal.aborted;
          return 'done';
        },
        {
          externalSignal: external.signal,
          onLogFlush: (logs) => flushedLogs.push(...logs),
        },
      );

      expect(receivedAborted).toBe(true);
      expect(flushedLogs.length).toBeGreaterThan(0);
    });
  });

  describe('CompileService (5-Stage Pipeline & Result Factory)', () => {
    function createMockWorkspace(): jest.Mocked<IWorkspaceManager> {
      let state: BuildStateRecord | null = null;
      return {
        getScratchDir: jest.fn().mockReturnValue('/tmp/fake-scratch'),
        ensureScratch: jest.fn().mockResolvedValue('/tmp/fake-scratch'),
        syncFiles: jest
          .fn()
          .mockResolvedValue({ written: 1, unchanged: 0, deleted: 0 }),
        cleanScratch: jest.fn().mockResolvedValue(undefined),
        cleanAuxBuildCache: jest.fn().mockResolvedValue(undefined),
        purgeExtraneousFiles: jest.fn().mockResolvedValue(undefined),
        listAuxFiles: jest.fn().mockResolvedValue([]),
        readAuxFile: jest.fn().mockResolvedValue(null),
        readArtifact: jest.fn().mockResolvedValue(null),
        readBuildState: jest.fn().mockImplementation(async () => state),
        writeBuildState: jest
          .fn()
          .mockImplementation(async (_id, s) => {
            state = s;
          }),
        writeCachedArtifacts: jest.fn().mockResolvedValue(undefined),
      };
    }

    it('returns validation-problems when main TeX document is empty', async () => {
      const workspace = createMockWorkspace();
      const engine: ILatexEngine = {
        name: 'latexmk',
        isAvailable: jest.fn().mockResolvedValue(true),
        compile: jest.fn(),
      };
      const service = new CompileService(workspace, engine);

      const res = await service.execute({
        spaceId: 'space-1',
        mainFile: 'main.tex',
        source: '',
      });

      expect(res.success).toBe(false);
      expect(res.outcome).toBe('validation-problems');
      expect(engine.compile).not.toHaveBeenCalled();
    });

    it('returns terminated immediately when AbortSignal is already aborted', async () => {
      const workspace = createMockWorkspace();
      const engine: ILatexEngine = {
        name: 'latexmk',
        isAvailable: jest.fn().mockResolvedValue(true),
        compile: jest.fn(),
      };
      const service = new CompileService(workspace, engine);
      const ac = new AbortController();
      ac.abort();

      const res = await service.execute({
        spaceId: 'space-1',
        mainFile: 'main.tex',
        source: '\\documentclass{article}\\begin{document}Hi\\end{document}',
        signal: ac.signal,
      });

      expect(res.success).toBe(false);
      expect(res.outcome).toBe('terminated');
    });
  });

  describe('RemoteClsiClientAdapter (Per-Node Circuit Breaker + Active Failover)', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('fails over to healthy replica when primary node is unreachable', async () => {
      const config = {
        get: (key: string) =>
          key === 'CLSI_URLS'
            ? 'http://clsi-1:3013,http://clsi-2:3013'
            : undefined,
      } as unknown as ConfigService;

      const adapter = new RemoteClsiClientAdapter(config);
      const primaryUrl = adapter.getBaseUrl('page-xyz')!;
      const calledUrls: string[] = [];

      global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calledUrls.push(url);
        if (url.startsWith(primaryUrl)) {
          throw new Error('ECONNREFUSED');
        }
        return {
          ok: true,
          json: async () => ({ files: [{ name: 'output.pdf', size: 123, ext: '.pdf' }] }),
        } as Response;
      }) as typeof fetch;

      const files = await adapter.tryRemoteListAuxFiles('page-xyz');

      expect(files).toHaveLength(1);
      expect(calledUrls).toHaveLength(2);
      expect(calledUrls[0]).toContain(primaryUrl);
      expect(calledUrls[1]).not.toContain(primaryUrl);
    });
  });

  describe('ClsiMetrics (Prometheus Histogram Buckets)', () => {
    it('emits histogram buckets, sum, and count', () => {
      const metrics = new ClsiMetrics();
      metrics.record({
        engine: 'pdflatex',
        durationMs: 1200,
        success: true,
        isCached: false,
        isTimeout: false,
        pdfSizeBytes: 2048,
      });

      const prom = metrics.toPrometheus();
      expect(prom).toContain('clsi_compile_duration_seconds_bucket{le="2"} 1');
      expect(prom).toContain('clsi_compile_duration_seconds_bucket{le="1"} 0');
      expect(prom).toContain('clsi_compile_duration_seconds_count 1');
    });
  });
});
