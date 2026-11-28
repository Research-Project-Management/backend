import { ConfigService } from '@nestjs/config';
import { SafePath } from '@/modules/pages/clsi/domain/path.policy';
import { BoundedLruCache } from '@/modules/pages/clsi/domain/lru-cache';
import { UnsafePathException } from '@/modules/pages/clsi/domain/errors';
import { CompileLockService } from '@/modules/pages/clsi/services/compile-lock.service';
import { CompileService } from '@/modules/pages/clsi/services/compile.service';
import { ClsiRepository } from '@/modules/pages/clsi/clsi.repository';
import { LatexmkEngine } from '@/modules/pages/clsi/adapters/latexmk.adapter';
import { RemoteClsiClientAdapter } from '@/modules/pages/clsi/adapters/remote-clsi.adapter';
import { ClsiMetrics } from '@/modules/pages/clsi/adapters/metrics.adapter';
import {
  DEFAULT_COMPILE_TIMEOUT_LIMITS,
  resolveCompileTimeout,
  resolveCompileTimeoutLimits,
} from '@/modules/pages/clsi/domain/compile.policy';
import {
  buildZipBuffer,
  createZipStream,
} from '@/modules/pages/core';
import {
  TexcountCliAdapter,
  parseTexcountBriefOutput,
} from '@/modules/pages/clsi/adapters/texcount.adapter';
import { CompileSourceService } from '@/modules/pages/clsi/services/compile-source.service';
import {
  PandocAdapter,
  normalizePandocExportFormat,
} from '@/modules/pages/export-import';
import { unzipSync, strFromU8 } from 'fflate';
import type { ISandboxRunner } from '@/modules/pages/clsi/domain/ports';

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
    function createTestCompileService() {
      const sandboxRunner: jest.Mocked<ISandboxRunner> = {
        name: 'mock-sandbox',
        run: jest
          .fn()
          .mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
      };
      const workspace = new ClsiRepository('/tmp/fake-scratch');
      const engine = new LatexmkEngine(sandboxRunner);
      return { service: new CompileService(workspace, engine), sandboxRunner };
    }

    it('returns validation-problems when main TeX document is empty', async () => {
      const { service, sandboxRunner } = createTestCompileService();

      const res = await service.execute({
        spaceId: 'space-1',
        mainFile: 'main.tex',
        source: '',
      });

      expect(res.success).toBe(false);
      expect(res.outcome).toBe('validation-problems');
      expect(sandboxRunner.run).not.toHaveBeenCalled();
    });

    it('returns terminated immediately when AbortSignal is already aborted', async () => {
      const { service, sandboxRunner } = createTestCompileService();
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
      expect(sandboxRunner.run).not.toHaveBeenCalled();
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

  describe('CompileTimeoutPolicy (Server-Authoritative Tiered Timeout)', () => {
    it('applies tier defaults and clamps client-requested timeouts to server cap', () => {
      // Defaults by mode/priority
      expect(resolveCompileTimeout({})).toBe(
        DEFAULT_COMPILE_TIMEOUT_LIMITS.manualMs,
      );
      expect(resolveCompileTimeout({ priority: 'auto' })).toBe(
        DEFAULT_COMPILE_TIMEOUT_LIMITS.autoMs,
      );
      expect(resolveCompileTimeout({ draft: true })).toBe(
        DEFAULT_COMPILE_TIMEOUT_LIMITS.draftMs,
      );
      expect(resolveCompileTimeout({ syntaxOnly: true })).toBe(
        DEFAULT_COMPILE_TIMEOUT_LIMITS.syntaxOnlyMs,
      );

      // Client cannot exceed server cap (prevents 600s DoS)
      expect(resolveCompileTimeout({ requestedMs: 600_000 })).toBe(90_000);
      expect(
        resolveCompileTimeout({ requestedMs: 240_000, priority: 'auto' }),
      ).toBe(30_000);
      expect(
        resolveCompileTimeout({ requestedMs: 240_000, syntaxOnly: true }),
      ).toBe(20_000);

      // Client MAY request a shorter timeout, bounded by minMs (5s)
      expect(resolveCompileTimeout({ requestedMs: 12_000 })).toBe(12_000);
      expect(resolveCompileTimeout({ requestedMs: 100 })).toBe(5_000);
    });

    it('parses env overrides while enforcing absoluteMaxMs (240s) and tier <= manualMs', () => {
      const limits = resolveCompileTimeoutLimits({
        CLSI_COMPILE_TIMEOUT_MS: '180000',
        CLSI_AUTO_COMPILE_TIMEOUT_MS: '25000',
        CLSI_DRAFT_COMPILE_TIMEOUT_MS: '999999', // clamped to manualMs (180s)
      });

      expect(limits.manualMs).toBe(180_000);
      expect(limits.autoMs).toBe(25_000);
      expect(limits.draftMs).toBe(180_000);
      expect(resolveCompileTimeout({ requestedMs: 999_999 }, limits)).toBe(
        180_000,
      );

      // Even if env sets > 240s, absoluteMaxMs caps it
      const capped = resolveCompileTimeoutLimits({
        CLSI_COMPILE_TIMEOUT_MS: '900000',
      });
      expect(capped.manualMs).toBe(240_000);
    });
  });

  describe('ZipBuilder (fflate-backed packing & streaming)', () => {
    it('packs and streams valid ZIP archives while sanitizing traversal paths', async () => {
      const buf = buildZipBuffer([
        { path: '../sections/intro.tex', data: '\\section{Intro}' },
        { path: 'empty.txt', data: '' },
      ]);
      const unzipped = unzipSync(new Uint8Array(buf));
      expect(Object.keys(unzipped).sort()).toEqual([
        'empty.txt',
        'sections/intro.tex',
      ]);
      expect(strFromU8(unzipped['sections/intro.tex'])).toBe('\\section{Intro}');
      expect(unzipped['empty.txt'].byteLength).toBe(0);

      const stream = createZipStream([
        { path: 'main.tex', getData: async () => '\\documentclass{article}' },
        { path: 'missing.png', getData: async () => null },
      ]);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const streamedUnzip = unzipSync(new Uint8Array(Buffer.concat(chunks)));
      expect(Object.keys(streamedUnzip)).toEqual(['main.tex']);
      expect(strFromU8(streamedUnzip['main.tex'])).toBe(
        '\\documentclass{article}',
      );
    });
  });

  describe('TexcountCliAdapter (Real TeX Live texcount parser)', () => {
    it('parses texcount -brief -sub=section output into totals, sections, and per-file stats', () => {
      const sampleStdout = [
        '12+2+0 (1/0/1/0) Section: Introduction',
        '30+1+5 (1/1/2/1) Section: Method',
        '42+3+5 (2/1/3/1) File: main.tex',
        '18+1+0 (1/0/0/0) Included file: sections/appendix.tex',
        '60+4+5 (3/1/3/1) Total',
      ].join('\n');

      const parsed = parseTexcountBriefOutput(sampleStdout, 'main.tex');
      expect(parsed).not.toBeNull();
      expect(parsed!.wordsInText).toBe(60);
      expect(parsed!.wordsInHeaders).toBe(4);
      expect(parsed!.wordsInCaptions).toBe(5);
      expect(parsed!.headers).toBe(3);
      expect(parsed!.floats).toBe(1);
      expect(parsed!.mathInlines).toBe(3);
      expect(parsed!.mathDisplayed).toBe(1);
      expect(parsed!.sections).toHaveLength(2);
      expect(parsed!.sections[0]).toMatchObject({
        level: 'section',
        title: 'Introduction',
        words: 14,
      });
      expect(parsed!.perFileStats).toHaveLength(2);
      expect(parsed!.perFileStats[1].path).toBe('sections/appendix.tex');
    });

    it('routes texcount execution through injected ISandboxRunner and scopes CompileSourceService.planFiles queries by pageId', async () => {
      const sandboxRun = jest.fn().mockResolvedValue({
        exitCode: 0,
        stdout: '15+2+0 (1/0/0/0) File: main.tex\n',
        stderr: '',
        timedOut: false,
      });
      const adapter = new TexcountCliAdapter('texcount', {
        name: 'mock-sandbox',
        run: sandboxRun,
      });
      const stats = await adapter.countFiles({
        files: { 'main.tex': '\\section{Intro}\nHello sandbox world.' },
        rootFile: 'main.tex',
      });
      expect(sandboxRun).toHaveBeenCalledTimes(1);
      expect(stats?.totalWords).toBe(17);

      const SPACE_ID = '11111111-1111-4111-8111-111111111111';
      const PAGE_ID = '22222222-2222-4222-8222-222222222222';
      const DOC_ID = '33333333-3333-4333-8333-333333333333';
      const pageNodeFindMany = jest.fn().mockResolvedValue([]);
      const pageDocFindMany = jest.fn().mockResolvedValue([]);
      const pageFileFindMany = jest.fn().mockResolvedValue([]);

      const compileSource = new CompileSourceService({
        page: {
          findUnique: jest.fn().mockResolvedValue(null),
          findFirst: jest.fn().mockResolvedValue({ id: PAGE_ID }),
        },
        pageDoc: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ pageId: PAGE_ID, spaceId: SPACE_ID }),
          findMany: pageDocFindMany,
        },
        pageNode: { findMany: pageNodeFindMany },
        pageFile: { findMany: pageFileFindMany },
      } as never);

      const ctx = await compileSource.resolvePageCompileContext(
        { pageId: DOC_ID },
        SPACE_ID,
      );
      expect(ctx).toEqual({ spaceId: SPACE_ID, pageId: PAGE_ID });

      await compileSource.planFiles(SPACE_ID, { spaceId: SPACE_ID }, PAGE_ID);
      expect(pageNodeFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { spaceId: SPACE_ID, pageId: PAGE_ID },
        }),
      );
      expect(pageDocFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { spaceId: SPACE_ID, pageId: PAGE_ID, deletedAt: null },
        }),
      );
      expect(pageFileFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { spaceId: SPACE_ID, pageId: PAGE_ID, deletedAt: null },
        }),
      );
    });
  });

  describe('PandocAdapter (LaTeX <-> DOCX/MD/HTML)', () => {
    it('normalizes export formats and gracefully returns null when pandoc binary is absent', async () => {
      expect(normalizePandocExportFormat('docx')).toBe('docx');
      expect(normalizePandocExportFormat('word')).toBe('docx');
      expect(normalizePandocExportFormat('markdown')).toBe('md');
      expect(normalizePandocExportFormat('HTML')).toBe('html');
      expect(normalizePandocExportFormat('pdf')).toBeNull();

      const missingBinAdapter = new PandocAdapter('nonexistent-pandoc-bin-xyz');
      const result = await missingBinAdapter.exportLatex({
        rawFilename: 'main.tex',
        content: '\\section{Intro} Hello',
        format: 'docx',
      });
      expect(result).toBeNull();
    });
  });
});
