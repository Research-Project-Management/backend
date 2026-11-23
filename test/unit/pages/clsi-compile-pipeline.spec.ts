import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { HttpException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { RealtimeFacade } from '@/modules/realtime/realtime.facade';
import {
  CompilePipeline,
  LatexmkEngine,
} from '@/modules/pages/clsi/services/compile-pipeline.service';
import { ClsiService } from '@/modules/pages/clsi/services/clsi.service';
import { CompileLockService } from '@/modules/pages/clsi/services/compile-lock.service';
import { RemoteClsiClientError } from '@/modules/pages/clsi/domain/sandbox.errors';
import { RemoteClsiClientAdapter } from '@/modules/pages/clsi/services/remote-clsi.client';
import { WorkspaceRepository } from '@/modules/pages/clsi/repositories/workspace.repository';
import { WorkspacePlannerService } from '@/modules/pages/clsi/services/workspace-planner.service';
import {
  planDbFileSet,
  planInlineFileSet,
  validatePlannedFileSet,
} from '@/modules/pages/clsi/domain/fileset.planner';
import { buildSandboxEnv } from '@/modules/pages/clsi/domain/sandbox-env.builder';
import type {
  ILatexEngine,
  ISandboxRunner,
} from '@/modules/pages/clsi/domain/clsi.ports';

const SPACE_ID = '11111111-1111-4111-8111-111111111111';
const PAGE_ID = '22222222-2222-4222-8222-222222222222';

describe('Block 3 CLSI Compile Pipeline & Remote Contract Regression Tests', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('preserves output.pdf and returns non-empty PDF on disk cache-hit without purging output artifacts', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'clsi-cache-hit-'));
    try {
      const workspace = new WorkspaceRepository(tmpRoot);
      const mockEngine: jest.Mocked<ILatexEngine> = {
        name: 'latexmk',
        isAvailable: jest.fn().mockResolvedValue(true),
        compile: jest.fn().mockImplementation(async (opts) => {
          await fs.writeFile(
            path.join(opts.cwd, 'output.pdf'),
            '%PDF-1.5 mock content',
          );
          await fs.writeFile(
            path.join(opts.cwd, 'output.log'),
            'Output written on output.pdf (1 page).',
          );
          await fs.writeFile(
            path.join(opts.cwd, 'output.synctex.gz'),
            zlib.gzipSync('SyncTeX Version:1\nInput:1:./main.tex\n'),
          );
          return {
            exitCode: 0,
            stdout: 'ok',
            stderr: '',
            durationMs: 25,
            pdfGenerated: true,
            synctexGenerated: true,
          };
        }),
      };

      const pipeline = new CompilePipeline(workspace, mockEngine);
      const req = {
        projectId: 'proj-cache-hit',
        mainFile: 'main.tex',
        source:
          '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}',
      };

      const first = await pipeline.execute(req);
      expect(first.success).toBe(true);
      expect(Buffer.from(first.pdf || '', 'base64').toString('utf8')).toBe(
        '%PDF-1.5 mock content',
      );
      expect(mockEngine.compile).toHaveBeenCalledTimes(1);

      const second = await pipeline.execute(req);
      expect(second.success).toBe(true);
      expect(Buffer.from(second.pdf || '', 'base64').toString('utf8')).toBe(
        '%PDF-1.5 mock content',
      );
      // Second compile hit the disk cache rather than re-running latexmk or purging output.pdf
      expect(mockEngine.compile).toHaveBeenCalledTimes(1);

      const scratchPdfStat = await fs.stat(
        path.join(workspace.getScratchDir('proj-cache-hit'), 'output.pdf'),
      );
      expect(scratchPdfStat.size).toBeGreaterThan(0);
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('never overwrites child chapters/*.tex in planDbFileSet when source contains \\documentclass', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const plan = planDbFileSet({
      nodes: [
        {
          id: 'node-root',
          docId: 'doc-root',
          path: '/main.tex',
          name: 'main.tex',
          type: 'DOC',
          isRootDoc: true,
        },
        {
          id: 'node-ch2',
          docId: 'doc-ch2',
          path: '/chapters/ch2.tex',
          name: 'ch2.tex',
          type: 'DOC',
          isRootDoc: false,
        },
      ],
      docs: [
        {
          id: 'doc-root',
          path: '/main.tex',
          rev: 1,
          sizeBytes: 64,
          updatedAt: now,
        },
        {
          id: 'doc-ch2',
          path: '/chapters/ch2.tex',
          rev: 2,
          sizeBytes: 120,
          updatedAt: now,
        },
      ],
      incomingFiles: {},
      source: '\\documentclass{article}\n\\input{chapters/ch2}',
      mainFile: 'main.tex',
      pageId: 'doc-ch2',
    });

    expect(plan.mainFile).toBe('main.tex');
    expect(plan.files.get('chapters/ch2.tex')?.kind).toBe('db');
  });

  it('sends canonical spaceId and pageId (not stripped projectId) in RemoteClsiClientAdapter', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        status: 'success',
        pdf: Buffer.from('%PDF-1.5 remote').toString('base64'),
        logs: 'ok',
        durationMs: 15,
      }),
    } as unknown as Response);

    const config = {
      get: jest.fn((key: string) =>
        key === 'CLSI_URL' ? 'http://localhost:3013' : undefined,
      ),
    } as unknown as ConfigService;

    const client = new RemoteClsiClientAdapter(config);
    const res = await client.tryRemoteClsiCompile({
      projectId: PAGE_ID,
      spaceId: SPACE_ID,
      pageId: PAGE_ID,
      mainFile: 'main.tex',
      source: '\\documentclass{article}',
      mergedFiles: { 'main.tex': '\\documentclass{article}' },
      dto: { forceClean: true, engine: 'xelatex' } as any,
      engine: 'xelatex',
      cacheKey: 'k1',
    });

    expect(res?.success).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://localhost:3013/compile');
    const body = JSON.parse(String(init?.body));
    expect(body.spaceId).toBe(SPACE_ID);
    expect(body.pageId).toBe(PAGE_ID);
    expect(body.projectId).toBeUndefined();
    expect(body.mainFile).toBe('main.tex');
    expect(body.forceClean).toBe(true);
    expect(body.engine).toBe('xelatex');
  });

  it('returns artifact URLs and strips Base64 PDF/SyncTeX when responseMode is "artifact"', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'clsi-art-mode-'));
    try {
      const workspace = new WorkspaceRepository(tmpRoot);
      const mockPlanner = {
        resolvePageCompileContext: jest
          .fn()
          .mockResolvedValue({ spaceId: SPACE_ID, pageId: PAGE_ID }),
        planFiles: jest.fn().mockResolvedValue({
          mainFile: 'main.tex',
          files: new Map(),
          fingerprint: 'fp-1',
          hasMainContent: true,
        }),
        hydrateFiles: jest.fn().mockResolvedValue({
          'main.tex':
            '\\documentclass{article}\\begin{document}Hi\\end{document}',
        }),
        recordCompileSnapshotIfEligible: jest.fn().mockResolvedValue(undefined),
      } as unknown as WorkspacePlannerService;

      const pdfBytes = Buffer.from('%PDF-1.5 artifact-stream-bytes');
      const synctexBytes = zlib.gzipSync('SyncTeX Version:1\n');
      const mockPipeline = {
        runWithProjectLock: jest.fn((_, fn) => fn()),
        execute: jest.fn().mockImplementation(async (req) => {
          const dir = await workspace.ensureScratch(req.projectId);
          await fs.writeFile(path.join(dir, 'output.pdf'), pdfBytes);
          await fs.writeFile(path.join(dir, 'output.synctex.gz'), synctexBytes);
          return {
            success: true,
            status: 'success',
            pdf: pdfBytes.toString('base64'),
            synctex: synctexBytes.toString('base64'),
            logs: 'Output written on output.pdf',
            durationMs: 20,
          };
        }),
      } as unknown as CompilePipeline;

      const remoteClient = {
        isEnabled: jest.fn().mockReturnValue(false),
        getBaseUrl: jest.fn().mockReturnValue(null),
        tryRemoteClsiCompile: jest.fn().mockResolvedValue(null),
      } as unknown as RemoteClsiClientAdapter;

      const clsi = new ClsiService(
        { get: jest.fn(() => undefined) } as unknown as ConfigService,
        undefined,
        undefined,
        undefined,
        remoteClient,
        mockPlanner,
        workspace,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        mockPipeline,
      );

      const artifactRes = await clsi.compileInline({
        spaceId: SPACE_ID,
        pageId: PAGE_ID,
        mainFile: 'main.tex',
        responseMode: 'artifact',
      });
      expect(artifactRes.success).toBe(true);
      if (artifactRes.success) {
        expect(artifactRes.pdf).toBe('');
        expect(artifactRes.synctex).toBeUndefined();
        expect(artifactRes.pdfArtifactUrl).toMatch(
          new RegExp(
            `^/api/v1/pages/pages/${PAGE_ID}/artifacts/output\\.pdf\\?v=`,
          ),
        );
        expect(artifactRes.synctexArtifactUrl).toMatch(
          new RegExp(
            `^/api/v1/pages/pages/${PAGE_ID}/artifacts/output\\.synctex\\.gz\\?v=`,
          ),
        );
        expect(artifactRes.synctexAvailable).toBe(true);
        expect(artifactRes.pdfSizeBytes).toBe(pdfBytes.byteLength);
      }

      const inlineRes = await clsi.compileInline({
        spaceId: SPACE_ID,
        pageId: PAGE_ID,
        mainFile: 'main.tex',
      });
      expect(inlineRes.success).toBe(true);
      if (inlineRes.success) {
        expect(inlineRes.pdf).toBe(pdfBytes.toString('base64'));
        expect(inlineRes.pdfArtifactUrl).toBeDefined();
      }
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('surfaces actionable CLSI_URL / flux_clsi error when remote CLSI is unreachable and no local TeX is installed', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'clsi-unreach-'));
    try {
      const workspace = new WorkspaceRepository(tmpRoot);
      const mockPlanner = {
        resolvePageCompileContext: jest
          .fn()
          .mockResolvedValue({ spaceId: SPACE_ID, pageId: PAGE_ID }),
        planFiles: jest.fn().mockResolvedValue({
          mainFile: 'main.tex',
          files: new Map(),
          fingerprint: 'fp-2',
          hasMainContent: true,
        }),
        hydrateFiles: jest.fn().mockResolvedValue({
          'main.tex': '\\documentclass{article}',
        }),
      } as unknown as WorkspacePlannerService;

      const mockPipeline = {
        runWithProjectLock: jest.fn((_, fn) => fn()),
        execute: jest.fn().mockResolvedValue({
          success: false,
          status: 'failure',
          error:
            'No supported TeX engine (latexmk/pdflatex) was found in PATH or sandbox runner.',
          logs: 'No supported TeX engine found.',
          durationMs: 5,
        }),
      } as unknown as CompilePipeline;

      const remoteClient = {
        isEnabled: jest.fn().mockReturnValue(true),
        getBaseUrl: jest.fn().mockReturnValue('http://localhost:3013'),
        tryRemoteClsiCompile: jest.fn().mockResolvedValue(null),
      } as unknown as RemoteClsiClientAdapter;

      const clsi = new ClsiService(
        { get: jest.fn(() => undefined) } as unknown as ConfigService,
        undefined,
        undefined,
        undefined,
        remoteClient,
        mockPlanner,
        workspace,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        mockPipeline,
      );

      const res = await clsi.compileInline({
        spaceId: SPACE_ID,
        pageId: PAGE_ID,
        mainFile: 'main.tex',
      });
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.outcome).toBe('clsi-unavailable');
        expect(res.error).toContain('http://localhost:3013');
        expect(res.error).toContain('flux_clsi');
        expect(res.diagnostics).toEqual([]);
      }
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('forwards TeX cache env vars while enforcing openin_any=p by default and openin_any=r only when requested for LuaLaTeX', () => {
    const parentEnv = {
      PATH: '/usr/bin',
      HOME: '/home/nestjs',
      TEXMFVAR: '/var/cache/texmf-var',
      TEXMFCACHE: '/var/cache/texmf-var',
      XDG_CACHE_HOME: '/tmp/xdg',
      DATABASE_URL: 'postgres://secret',
      JWT_SECRET: 'supersecret',
    };

    const defaultEnv = buildSandboxEnv({
      parentEnv,
      platform: 'linux',
      isTexProcess: true,
    });
    expect(defaultEnv.openin_any).toBe('p');
    expect(defaultEnv.openout_any).toBe('p');
    expect(defaultEnv.shell_escape).toBe('f');
    expect(defaultEnv.HOME).toBe('/home/nestjs');
    expect(defaultEnv.TEXMFVAR).toBe('/var/cache/texmf-var');
    expect(defaultEnv.TEXMFCACHE).toBe('/var/cache/texmf-var');
    expect(defaultEnv.XDG_CACHE_HOME).toBe('/tmp/xdg');
    expect(defaultEnv.DATABASE_URL).toBeUndefined();
    expect(defaultEnv.JWT_SECRET).toBeUndefined();

    const luaEnv = buildSandboxEnv({
      parentEnv,
      platform: 'linux',
      isTexProcess: true,
      openinAny: 'r',
    });
    expect(luaEnv.openin_any).toBe('r');
    expect(luaEnv.openout_any).toBe('p');
    expect(luaEnv.shell_escape).toBe('f');
  });

  it('RemoteClsiClientAdapter propagates 4xx and structured 503 backpressure without tripping circuit breaker, while opening backoff on raw 5xx', async () => {
    const adapter = new RemoteClsiClientAdapter({
      get: jest.fn((key: string) =>
        key === 'CLSI_URL' ? 'http://clsi.internal:3013' : undefined,
      ),
    } as unknown as ConfigService);

    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        json: async () => ({
          error: {
            code: 'AUTO_COMPILE_SHED',
            message: 'Auto-compilation shed under high queue contention',
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({
          error: {
            code: 'COMPILE_QUEUE_FULL',
            message: 'Compile queue is full',
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          status: 'success',
          pdf: Buffer.from('%PDF-1.5 recovered').toString('base64'),
          logs: 'ok',
          durationMs: 12,
        }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ message: 'Internal failure' }),
      });

    const originalFetch = global.fetch;
    global.fetch = fetchMock;
    try {
      const baseReq = {
        projectId: 'proj-cb',
        mainFile: 'main.tex',
        source: '\\documentclass{article}',
        mergedFiles: {},
        dto: { mainFile: 'main.tex', priority: 'auto' as const },
        cacheKey: 'ck-1',
      };

      await expect(adapter.tryRemoteClsiCompile(baseReq)).rejects.toThrow(
        RemoteClsiClientError,
      );
      await expect(adapter.tryRemoteClsiCompile(baseReq)).rejects.toMatchObject(
        {
          statusCode: 503,
          code: 'COMPILE_QUEUE_FULL',
        },
      );

      // Circuit breaker remained closed after 429 & structured 503 backpressure
      const recovered = await adapter.tryRemoteClsiCompile(baseReq);
      expect(recovered?.success).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(3);

      // Raw 500 returns null fallback AND opens 10s circuit breaker
      const raw500Res = await adapter.tryRemoteClsiCompile(baseReq);
      expect(raw500Res).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(4);

      const backedOffRes = await adapter.tryRemoteClsiCompile(baseReq);
      expect(backedOffRes).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(4);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('CompileLockService sheds auto-compile at autoShedThreshold, allows manual builds up to compileConcurrencyLimit, and fails fast with 503 TOO_MANY_COMPILE_REQUESTS when capacity is reached (Overleaf LockManager.js:39-51)', async () => {
    const lockService = new CompileLockService({
      maxConcurrentCompiles: 2,
      autoShedThreshold: 1,
      maxCompilesPerMinute: 2,
    });

    let releaseFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      void lockService.runWithLock('proj-1', 'user-1', undefined, async () => {
        resolve();
        await new Promise<void>((done) => {
          releaseFirst = done;
        });
        return 'first-done';
      });
    });
    await firstEntered;

    // Active count is now 1 (>= autoShedThreshold=1): auto compile must shed immediately with 429 AUTO_COMPILE_SHED
    let shedErr: unknown;
    try {
      await lockService.runWithLock(
        'proj-3',
        'user-3',
        undefined,
        async () => 'auto',
        {
          priority: 'auto',
        },
      );
    } catch (err) {
      shedErr = err;
    }
    expect(shedErr).toBeInstanceOf(HttpException);
    expect((shedErr as HttpException).getStatus()).toBe(429);
    expect((shedErr as HttpException).getResponse()).toEqual(
      expect.objectContaining({
        code: 'AUTO_COMPILE_SHED',
        status: 'autocompile-backoff',
      }),
    );

    // Manual compile for proj-2 is still accepted and runs concurrently (active count becomes 2 == maxConcurrentCompiles)
    let releaseSecond!: () => void;
    let secondPromise!: Promise<string>;
    const secondEntered = new Promise<void>((resolve) => {
      secondPromise = lockService.runWithLock(
        'proj-2',
        'user-2',
        undefined,
        async () => {
          resolve();
          await new Promise<void>((done) => {
            releaseSecond = done;
          });
          return 'second-done';
        },
        { priority: 'manual' },
      );
    });
    await secondEntered;

    // Active count is now 2 (== maxConcurrentCompiles=2): 3rd concurrent project fails fast (0ms, no queue) with 503 TOO_MANY_COMPILE_REQUESTS
    let capErr: unknown;
    try {
      await lockService.runWithLock(
        'proj-3',
        'user-3',
        undefined,
        async () => 'third-manual',
        { priority: 'manual' },
      );
    } catch (err) {
      capErr = err;
    }
    expect(capErr).toBeInstanceOf(HttpException);
    expect((capErr as HttpException).getStatus()).toBe(503);
    expect((capErr as HttpException).getResponse()).toEqual(
      expect.objectContaining({
        code: 'TOO_MANY_COMPILE_REQUESTS',
        status: 'unavailable',
        message: 'too many concurrent compile requests',
      }),
    );

    releaseFirst();
    releaseSecond();
    await expect(secondPromise).resolves.toBe('second-done');

    // Rate limit exhaustion emits structured 429 COMPILE_RATE_LIMITED
    await lockService.runWithLock(
      'proj-rate',
      'user-rate',
      undefined,
      async () => 1,
    );
    await lockService.runWithLock(
      'proj-rate',
      'user-rate',
      undefined,
      async () => 2,
    );
    let rateErr: unknown;
    try {
      await lockService.runWithLock(
        'proj-rate',
        'user-rate',
        undefined,
        async () => 3,
      );
    } catch (err) {
      rateErr = err;
    }
    expect(rateErr).toBeInstanceOf(HttpException);
    expect((rateErr as HttpException).getStatus()).toBe(429);
    expect((rateErr as HttpException).getResponse()).toEqual(
      expect.objectContaining({ code: 'COMPILE_RATE_LIMITED' }),
    );

    lockService.onModuleDestroy();
  });

  it('ClsiService.compileInline forwards dto.priority into CompileLockService.runWithLock', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'clsi-prio-'));
    try {
      const workspace = new WorkspaceRepository(tmpRoot);
      const mockPlanner = {
        resolvePageCompileContext: jest
          .fn()
          .mockResolvedValue({ spaceId: SPACE_ID, pageId: PAGE_ID }),
        planFiles: jest.fn().mockResolvedValue({
          mainFile: 'main.tex',
          files: new Map(),
          fingerprint: 'fp-prio',
          hasMainContent: true,
        }),
        hydrateFiles: jest.fn().mockResolvedValue({
          'main.tex': '\\documentclass{article}',
        }),
        recordCompileSnapshotIfEligible: jest.fn().mockResolvedValue(undefined),
      } as unknown as WorkspacePlannerService;

      const mockPipeline = {
        runWithProjectLock: jest.fn((_, fn) => fn()),
        execute: jest.fn().mockResolvedValue({
          success: true,
          status: 'success',
          pdf: Buffer.from('%PDF-1.5').toString('base64'),
          logs: 'ok',
          durationMs: 5,
        }),
      } as unknown as CompilePipeline;

      const remoteClient = {
        isEnabled: jest.fn().mockReturnValue(false),
        getBaseUrl: jest.fn().mockReturnValue(null),
        tryRemoteClsiCompile: jest.fn().mockResolvedValue(null),
      } as unknown as RemoteClsiClientAdapter;

      const compileLock = new CompileLockService();
      const runWithLockSpy = jest.spyOn(compileLock, 'runWithLock');

      const clsi = new ClsiService(
        { get: jest.fn(() => undefined) } as unknown as ConfigService,
        undefined,
        undefined,
        undefined,
        remoteClient,
        mockPlanner,
        workspace,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        mockPipeline,
        compileLock,
      );

      await clsi.compileInline({
        spaceId: SPACE_ID,
        pageId: PAGE_ID,
        mainFile: 'main.tex',
        priority: 'auto',
      });

      expect(runWithLockSpy).toHaveBeenCalledWith(
        PAGE_ID,
        undefined,
        undefined,
        expect.any(Function),
        { priority: 'auto' },
      );
      clsi.onModuleDestroy();
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('CompileLockService batches rapid onLogChunk bursts bounded by maxLogChunkBytes and clears timer on settle', async () => {
    const lockService = new CompileLockService({
      maxConcurrentCompiles: 1,
      logChunkFlushIntervalMs: 30,
      maxLogChunkBytes: 64,
    });
    const broadcastMock = jest.fn();
    const realtimeMock = {
      broadcastCompileProgress: broadcastMock,
    } as unknown as RealtimeFacade;

    await lockService.runWithLock(
      'proj-batch-logs',
      'user-batch',
      realtimeMock,
      async (_signal, onLogChunk) => {
        for (let i = 0; i < 10; i++) {
          onLogChunk(`CHUNK_${i}_${'X'.repeat(20)}\n`);
        }
        await new Promise((r) => setTimeout(r, 60));
        onLogChunk('TRAILING_UNFLUSHED_CHUNK');
        return 'ok';
      },
    );

    await new Promise((r) => setTimeout(r, 50));

    const chunkCalls = broadcastMock.mock.calls.filter(([, payload]) => {
      const p = payload as { status?: string; logs?: string[] };
      return (
        p.status === 'compiling' &&
        !p.logs?.[0]?.startsWith('[CLSI Queue]') &&
        !p.logs?.[0]?.startsWith('[CLSI]')
      );
    });
    expect(chunkCalls).toHaveLength(1);
    const flushedText = (chunkCalls[0]?.[1] as { logs: string[] }).logs[0];
    expect(flushedText.length).toBeLessThanOrEqual(64);
    expect(flushedText).toContain('CHUNK_9_');
    expect(flushedText).not.toContain('TRAILING_UNFLUSHED_CHUNK');

    lockService.onModuleDestroy();
  });

  it('ClsiService.compileInline broadcasts lightweight completion summary metadata instead of large raw logs', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'clsi-ws-meta-'));
    try {
      const workspace = new WorkspaceRepository(tmpRoot);
      const mockPlanner = {
        resolvePageCompileContext: jest
          .fn()
          .mockResolvedValue({ spaceId: SPACE_ID, pageId: PAGE_ID }),
        planFiles: jest.fn().mockResolvedValue({
          mainFile: 'main.tex',
          files: new Map(),
          fingerprint: 'fp-ws-meta',
          hasMainContent: true,
        }),
        hydrateFiles: jest.fn().mockResolvedValue({
          'main.tex': '\\documentclass{article}',
        }),
        recordCompileSnapshotIfEligible: jest.fn().mockResolvedValue(undefined),
      } as unknown as WorkspacePlannerService;

      const hugeRawLog = 'TRACE_LINE\n'.repeat(2000);
      const mockPipeline = {
        runWithProjectLock: jest.fn((_, fn) => fn()),
        execute: jest.fn().mockImplementation(async (req) => {
          const dir = await workspace.ensureScratch(req.projectId);
          await fs.writeFile(path.join(dir, 'output.log'), hugeRawLog);
          return {
            success: false,
            status: 'failure',
            outcome: 'failure',
            error: 'Undefined control sequence.',
            logs: hugeRawLog,
            diagnostics: [],
            diagnosticsSummary: {
              totalErrors: 1,
              totalWarnings: 2,
              totalBadboxes: 3,
              suppressedCascadeCount: 0,
              truncated: false,
            },
            durationMs: 42,
          };
        }),
      } as unknown as CompilePipeline;

      const remoteClient = {
        isEnabled: jest.fn().mockReturnValue(false),
        getBaseUrl: jest.fn().mockReturnValue(null),
        tryRemoteClsiCompile: jest.fn().mockResolvedValue(null),
      } as unknown as RemoteClsiClientAdapter;

      const broadcastMock = jest.fn();
      const realtimeMock = {
        flushProjectBeforeCompile: jest.fn().mockResolvedValue(undefined),
        broadcastCompileProgress: broadcastMock,
      } as unknown as RealtimeFacade;

      const clsi = new ClsiService(
        { get: jest.fn(() => undefined) } as unknown as ConfigService,
        undefined,
        realtimeMock,
        undefined,
        remoteClient,
        mockPlanner,
        workspace,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        mockPipeline,
      );

      await clsi.compileInline({
        spaceId: SPACE_ID,
        pageId: PAGE_ID,
        mainFile: 'main.tex',
      });

      const failedBroadcast = broadcastMock.mock.calls.find(([, payload]) => {
        const p = payload as { status?: string };
        return p.status === 'failed';
      });
      expect(failedBroadcast).toBeDefined();
      const wsPayload = failedBroadcast?.[1] as {
        status: string;
        logs: string[];
        summary: {
          totalErrors: number;
          totalWarnings: number;
          totalBadboxes: number;
        };
        logArtifactUrl?: string;
      };
      expect(wsPayload.logs).toEqual([
        '[CLSI] Compilation failed: Undefined control sequence.',
      ]);
      expect(wsPayload.logs[0]).not.toContain('TRACE_LINE');
      expect(wsPayload.summary).toEqual({
        totalErrors: 1,
        totalWarnings: 2,
        totalBadboxes: 3,
      });
      expect(wsPayload.logArtifactUrl).toContain('output.log');

      clsi.onModuleDestroy();
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  describe('Main File SSOT & Workspace Planner Fallback Hardening', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const DOC_PERSONAL_ID = '33333333-3333-4333-8333-333333333333';

    it('planDbFileSet prioritizes authoritative detectedRootPath over stale missing explicit mainFile', () => {
      const plan = planDbFileSet({
        nodes: [
          {
            id: 'node-personal',
            docId: DOC_PERSONAL_ID,
            path: '/personal-notes.tex',
            name: 'personal-notes.tex',
            type: 'DOC',
            isRootDoc: true,
          },
        ],
        docs: [
          {
            id: DOC_PERSONAL_ID,
            path: 'personal-notes.tex',
            rev: 1,
            sizeBytes: 180,
            updatedAt: now,
          },
        ],
        incomingFiles: {},
        source: '',
        mainFile: 'flux.tex',
        pageId: PAGE_ID,
      });

      expect(plan.mainFile).toBe('personal-notes.tex');
      expect(plan.hasMainContent).toBe(true);
      expect(validatePlannedFileSet(plan)).toEqual([]);
    });

    it('planDbFileSet falls back to non-empty workspace .tex when Page.rootDocId is unset and explicit mainFile is missing', () => {
      const plan = planDbFileSet({
        nodes: [
          {
            id: 'node-personal',
            docId: DOC_PERSONAL_ID,
            path: '/personal-notes.tex',
            name: 'personal-notes.tex',
            type: 'DOC',
            isRootDoc: false,
          },
        ],
        docs: [
          {
            id: DOC_PERSONAL_ID,
            path: 'personal-notes.tex',
            rev: 1,
            sizeBytes: 180,
            updatedAt: now,
          },
        ],
        incomingFiles: {},
        source: '',
        mainFile: 'flux.tex',
        pageId: PAGE_ID,
      });

      expect(plan.mainFile).toBe('personal-notes.tex');
      expect(plan.hasMainContent).toBe(true);
      expect(validatePlannedFileSet(plan)).toEqual([]);
    });

    it('planDbFileSet preserves validation-problems when designated root doc exists but is empty', () => {
      const plan = planDbFileSet({
        nodes: [
          {
            id: 'node-root',
            docId: DOC_PERSONAL_ID,
            path: '/main.tex',
            name: 'main.tex',
            type: 'DOC',
            isRootDoc: true,
          },
          {
            id: 'node-ch1',
            docId: '44444444-4444-4444-8444-444444444444',
            path: '/chapters/ch1.tex',
            name: 'ch1.tex',
            type: 'DOC',
            isRootDoc: false,
          },
        ],
        docs: [
          {
            id: DOC_PERSONAL_ID,
            path: 'main.tex',
            rev: 1,
            sizeBytes: 0,
            updatedAt: now,
          },
          {
            id: '44444444-4444-4444-8444-444444444444',
            path: 'chapters/ch1.tex',
            rev: 1,
            sizeBytes: 85,
            updatedAt: now,
          },
        ],
        incomingFiles: {},
        source: '',
        pageId: PAGE_ID,
      });

      expect(plan.mainFile).toBe('main.tex');
      expect(plan.hasMainContent).toBe(false);
      const issues = validatePlannedFileSet(plan);
      expect(issues.map((i) => i.code)).toContain('mainFile');
    });

    it('planInlineFileSet ignores stale missing explicit mainFile when incomingFiles contain a valid document', () => {
      const plan = planInlineFileSet({
        incomingFiles: {
          'personal-notes.tex':
            '\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}',
        },
        source: '',
        mainFile: 'flux.tex',
      });

      expect(plan.mainFile).toBe('personal-notes.tex');
      expect(plan.hasMainContent).toBe(true);
    });

    it('WorkspacePlannerService.planFiles falls back to rootDocIds / isRootDoc when page.rootDocId is null', async () => {
      const mockPrisma = {
        page: {
          findUnique: jest.fn().mockResolvedValue({
            spaceId: SPACE_ID,
            rootDocId: DOC_PERSONAL_ID,
            deletedAt: null,
          }),
        },
        pageNode: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'node-personal',
              pageId: PAGE_ID,
              docId: DOC_PERSONAL_ID,
              fileId: null,
              path: '/personal-notes.tex',
              name: 'personal-notes.tex',
              type: 'DOC',
              page: { rootDocId: null },
            },
          ]),
        },
        pageDoc: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: DOC_PERSONAL_ID,
              pageId: PAGE_ID,
              lastKnownPath: 'personal-notes.tex',
              rev: 1,
              sizeBytes: 220,
              updatedAt: now,
              inStorage: false,
            },
          ]),
        },
        pageFile: {
          findMany: jest.fn().mockResolvedValue([]),
        },
      };

      const planner = new WorkspacePlannerService(mockPrisma as never);
      const plan = await planner.planFiles(
        SPACE_ID,
        {
          spaceId: SPACE_ID,
          pageId: PAGE_ID,
          mainFile: 'flux.tex',
          files: {},
          source: '',
        },
        PAGE_ID,
      );

      expect(plan.nodes?.[0]?.isRootDoc).toBe(true);
      expect(plan.mainFile).toBe('personal-notes.tex');
      expect(plan.hasMainContent).toBe(true);
    });

    it('forces latexmk (-g via force: true) and skips cache hit when recompiling unchanged source after a failed build', async () => {
      const tmpRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), 'clsi-failed-retry-'),
      );
      try {
        const workspace = new WorkspaceRepository(tmpRoot);
        const mockEngine: jest.Mocked<ILatexEngine> = {
          name: 'latexmk',
          isAvailable: jest.fn().mockResolvedValue(true),
          compile: jest.fn().mockImplementation(async (opts) => {
            await fs.writeFile(
              path.join(opts.cwd, 'output.log'),
              '(./main.tex\n./main.tex:5: LaTeX Error: Unicode character ấ (U+1EA5)\n               not set up for use with LaTeX.\nl.5 \\author{Tấn Thành}\n',
            );
            return {
              exitCode: 1,
              stdout: '',
              stderr: '',
              durationMs: 15,
              pdfGenerated: false,
              synctexGenerated: false,
            };
          }),
        };

        const pipeline = new CompilePipeline(workspace, mockEngine);
        const req = {
          projectId: 'proj-failed-retry',
          mainFile: 'main.tex',
          source:
            '\\documentclass{article}\n\\author{Tấn Thành}\n\\begin{document}\nHi\n\\end{document}',
        };

        const first = await pipeline.execute(req);
        expect(first.success).toBe(false);
        expect(first.diagnosticsSummary?.totalErrors).toBe(1);
        expect(mockEngine.compile).toHaveBeenCalledTimes(1);

        const second = await pipeline.execute(req);
        expect(second.success).toBe(false);
        expect(second.diagnosticsSummary?.totalErrors).toBe(1);
        expect(mockEngine.compile).toHaveBeenCalledTimes(2);
        expect(mockEngine.compile.mock.calls[1][0].force).toBe(true);
      } finally {
        await fs.rm(tmpRoot, { recursive: true, force: true });
      }
    });

    it('purges stale aux build cache and passes force: true when switching compiler engine', async () => {
      const tmpRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), 'clsi-engine-switch-'),
      );
      try {
        const workspace = new WorkspaceRepository(tmpRoot);
        const scratchDir = workspace.getScratchDir('proj-engine-switch');
        const mockEngine: jest.Mocked<ILatexEngine> = {
          name: 'latexmk',
          isAvailable: jest.fn().mockResolvedValue(true),
          compile: jest.fn().mockImplementation(async (opts) => {
            await fs.writeFile(path.join(opts.cwd, 'output.pdf'), '%PDF-1.5');
            await fs.writeFile(path.join(opts.cwd, 'output.aux'), '\\relax');
            await fs.writeFile(
              path.join(opts.cwd, 'output.fdb_latexmk'),
              'fdb',
            );
            await fs.writeFile(
              path.join(opts.cwd, 'output.log'),
              'Output written on output.pdf (1 page).',
            );
            return {
              exitCode: 0,
              stdout: 'ok',
              stderr: '',
              durationMs: 20,
              pdfGenerated: true,
              synctexGenerated: false,
            };
          }),
        };

        const pipeline = new CompilePipeline(workspace, mockEngine);
        const source =
          '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}';

        const first = await pipeline.execute({
          projectId: 'proj-engine-switch',
          mainFile: 'main.tex',
          engine: 'pdflatex',
          source,
        });
        expect(first.success).toBe(true);
        await expect(
          fs.access(path.join(scratchDir, 'output.aux')),
        ).resolves.toBeUndefined();

        let auxExistedDuringSecondCompile = false;
        mockEngine.compile.mockImplementationOnce(async (opts) => {
          auxExistedDuringSecondCompile = await fs
            .access(path.join(opts.cwd, 'output.aux'))
            .then(() => true)
            .catch(() => false);
          await fs.writeFile(path.join(opts.cwd, 'output.pdf'), '%PDF-1.5');
          await fs.writeFile(
            path.join(opts.cwd, 'output.log'),
            'Output written on output.pdf (1 page).',
          );
          return {
            exitCode: 0,
            stdout: 'ok',
            stderr: '',
            durationMs: 20,
            pdfGenerated: true,
            synctexGenerated: false,
          };
        });

        const second = await pipeline.execute({
          projectId: 'proj-engine-switch',
          mainFile: 'main.tex',
          engine: 'xelatex',
          source,
        });
        expect(second.success).toBe(true);
        expect(auxExistedDuringSecondCompile).toBe(false);
        expect(mockEngine.compile.mock.calls[1][0].force).toBe(true);
        await expect(
          fs.access(path.join(scratchDir, 'main.tex')),
        ).resolves.toBeUndefined();
      } finally {
        await fs.rm(tmpRoot, { recursive: true, force: true });
      }
    });

    it('LatexmkEngine includes -g flag only when force is true', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'latexmk-g-'));
      try {
        const mockRunner: jest.Mocked<ISandboxRunner> = {
          name: 'local-process',
          run: jest.fn().mockResolvedValue({
            exitCode: 0,
            stdout: '',
            stderr: '',
          }),
        };
        const engine = new LatexmkEngine(mockRunner, 'latexmk', 'pdflatex');

        await engine.compile({
          cwd: tmpDir,
          mainFile: 'main.tex',
        });
        expect(mockRunner.run.mock.calls[0][1]).not.toContain('-g');

        await engine.compile({
          cwd: tmpDir,
          mainFile: 'main.tex',
          force: true,
        });
        expect(mockRunner.run.mock.calls[1][1]).toContain('-g');
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('RemoteClsiClientAdapter omits engine when neither engine nor dto.engine is provided', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          status: 'success',
          pdf: Buffer.from('%PDF-1.5 remote').toString('base64'),
          logs: 'ok',
          durationMs: 15,
        }),
      } as unknown as Response);

      const config = {
        get: jest.fn((key: string) =>
          key === 'CLSI_URL' ? 'http://localhost:3013' : undefined,
        ),
      } as unknown as ConfigService;

      const client = new RemoteClsiClientAdapter(config);
      await client.tryRemoteClsiCompile({
        projectId: PAGE_ID,
        spaceId: SPACE_ID,
        pageId: PAGE_ID,
        mainFile: 'main.tex',
        source: '% !TEX program = xelatex\n\\documentclass{article}',
        mergedFiles: { 'main.tex': '\\documentclass{article}' },
        dto: {},
        cacheKey: 'k-auto',
      });

      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string) as {
        engine?: string;
      };
      expect(body.engine).toBeUndefined();
    });

    it('CompileLockService enforces fail-fast compileConcurrencyLimit without a waiting queue and releases slot immediately upon completion (Overleaf LockManager.js:39-51)', async () => {
      const lockService = new CompileLockService({
        maxConcurrentCompiles: 1,
        autoShedThreshold: 1,
      });

      const executionOrder: string[] = [];
      let releaseActive!: () => void;
      let activePromise!: Promise<string>;
      const activeStarted = new Promise<void>((resolve) => {
        activePromise = lockService.runWithLock(
          'proj-active',
          'user-1',
          undefined,
          async () => {
            executionOrder.push('proj-active');
            resolve();
            await new Promise<void>((done) => {
              releaseActive = done;
            });
            return 'active-done';
          },
        );
      });
      await activeStarted;

      // While slot is occupied, another project fails fast with 503 TOO_MANY_COMPILE_REQUESTS (no waiting queue)
      await expect(
        lockService.runWithLock(
          'proj-manual-b',
          'user-b',
          undefined,
          async () => 'b-done',
          { priority: 'manual' },
        ),
      ).rejects.toMatchObject({
        status: 503,
        response: expect.objectContaining({
          code: 'TOO_MANY_COMPILE_REQUESTS',
          status: 'unavailable',
        }),
      });

      // As soon as proj-active finishes and releases its lock, proj-manual-b executes immediately
      releaseActive();
      await expect(activePromise).resolves.toBe('active-done');

      const bRes = await lockService.runWithLock(
        'proj-manual-b',
        'user-b',
        undefined,
        async () => {
          executionOrder.push('proj-manual-b');
          return 'b-done';
        },
        { priority: 'manual' },
      );
      expect(bRes).toBe('b-done');
      expect(executionOrder).toEqual(['proj-active', 'proj-manual-b']);
      lockService.onModuleDestroy();
    });

    it('CompileLockService isolates locks per (projectId, userId) so User 1 and User 2 in the same project compile concurrently and User 2 cannot cancel User 1 (Overleaf CompileManager.js:51-57, 415-428)', async () => {
      const lockService = new CompileLockService({
        maxConcurrentCompiles: 2,
        maxCompilesPerMinute: 2,
      });

      const executedBuilds: string[] = [];
      let releaseUser1Build!: () => void;
      let markUser1Running!: () => void;
      const user1Running = new Promise<void>((resolve) => {
        markUser1Running = resolve;
      });

      // User 1 starts compiling proj-paper (acquires lock `proj-paper-user-1`)
      const user1Promise = lockService.runWithLock(
        'proj-paper',
        'user-1',
        undefined,
        async (signal) => {
          executedBuilds.push('user-1-build');
          markUser1Running();
          await new Promise<void>((done) => {
            releaseUser1Build = done;
          });
          expect(signal.aborted).toBe(false);
          return 'pdf-user-1';
        },
      );
      await user1Running;

      // User 2 (a different user in the same project) attempts to cancel User 1's compile:
      // Per Overleaf stopCompile(projectId, userId), User 2 only targets `proj-paper-user-2` and CANNOT cancel User 1!
      expect(lockService.cancel('proj-paper', 'user-2')).toBe(false);
      expect(lockService.isInFlight('proj-paper', 'user-1')).toBe(true);

      // User 2 in the same project triggers compile while User 1 is still compiling:
      // Per Overleaf getCompileName(projectId, userId) = `${projectId}-${userId}`,
      // User 2 acquires `proj-paper-user-2` and compiles concurrently without being blocked by User 1!
      const user2Result = await lockService.runWithLock(
        'proj-paper',
        'user-2',
        undefined,
        async () => {
          executedBuilds.push('user-2-build');
          return 'pdf-user-2';
        },
      );
      expect(user2Result).toBe('pdf-user-2');

      // Meanwhile, if User 1 sends a duplicate overlapping compile request while `proj-paper-user-1` is still running,
      // LockManager rejects it with HTTP 423 Locked (`compile-in-progress`) without killing User 1's active build
      let dupErr: unknown;
      try {
        await lockService.runWithLock(
          'proj-paper',
          'user-1',
          undefined,
          async () => 'dup',
        );
      } catch (e) {
        dupErr = e;
      }
      expect(dupErr).toBeInstanceOf(HttpException);
      expect((dupErr as HttpException).getStatus()).toBe(423);
      expect((dupErr as HttpException).getResponse()).toEqual(
        expect.objectContaining({
          code: 'COMPILE_IN_PROGRESS',
          status: 'compile-in-progress',
          message: 'compile in progress',
        }),
      );

      // User 1's active build finishes cleanly
      releaseUser1Build();
      await expect(user1Promise).resolves.toBe('pdf-user-1');
      expect(executedBuilds).toEqual(['user-1-build', 'user-2-build']);

      lockService.onModuleDestroy();
    });

    it('CompileLockService stops active compile and waits for lock release when forceClean is true (Overleaf CompileController.js:234-245 clearCache parity)', async () => {
      const lockService = new CompileLockService({
        maxConcurrentCompiles: 2,
      });

      let firstSignalAborted = false;
      let markFirstRunning!: () => void;
      const firstRunning = new Promise<void>((resolve) => {
        markFirstRunning = resolve;
      });

      const firstPromise = lockService.runWithLock(
        'proj-clean',
        'user-1',
        undefined,
        async (signal) => {
          markFirstRunning();
          await new Promise<void>((resolve) => {
            signal.addEventListener(
              'abort',
              () => {
                firstSignalAborted = true;
                resolve();
              },
              { once: true },
            );
          });
          return 'aborted-v1';
        },
      );
      await firstRunning;

      const cleanPromise = lockService.runWithLock(
        'proj-clean',
        'user-1',
        undefined,
        async () => 'clean-v2',
        { forceClean: true },
      );

      await expect(firstPromise).resolves.toBe('aborted-v1');
      await expect(cleanPromise).resolves.toBe('clean-v2');
      expect(firstSignalAborted).toBe(true);

      lockService.onModuleDestroy();
    });

    it('WorkspacePlannerService.hydrateFiles + WorkspaceRepository.syncFiles achieve O(Delta D + Delta S_bin) by querying only changed rev docs from DB and using 0-byte disk placeholders for unchanged binaries', async () => {
      const tmpRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), 'clsi-delta-o1-'),
      );
      try {
        const workspace = new WorkspaceRepository(tmpRoot);
        const scratchDir = await workspace.ensureScratch(PAGE_ID);
        const figBytes = Buffer.from('heavy-50mb-figure-simulation-bytes');

        // Seed initial sync of 3 docs + 1 binary image onto disk
        await workspace.syncFiles(PAGE_ID, [
          {
            path: 'main.tex',
            content:
              '\\documentclass{article}\n\\input{ch1}\n\\input{ch2}\n\\begin{document}Main\\end{document}',
          },
          { path: 'ch1.tex', content: 'Chapter 1 initial' },
          { path: 'ch2.tex', content: 'Chapter 2 initial' },
          { path: 'fig.png', content: figBytes },
        ]);

        const baseNodes = [
          {
            id: 'n-main',
            docId: 'doc-main',
            fileId: null,
            path: '/main.tex',
            name: 'main.tex',
            type: 'DOC',
            isRootDoc: true,
          },
          {
            id: 'n-ch1',
            docId: 'doc-ch1',
            fileId: null,
            path: '/ch1.tex',
            name: 'ch1.tex',
            type: 'DOC',
            isRootDoc: false,
          },
          {
            id: 'n-ch2',
            docId: 'doc-ch2',
            fileId: null,
            path: '/ch2.tex',
            name: 'ch2.tex',
            type: 'DOC',
            isRootDoc: false,
          },
          {
            id: 'n-fig',
            docId: null,
            fileId: 'file-fig',
            path: '/fig.png',
            name: 'fig.png',
            type: 'FILE',
            isRootDoc: false,
          },
        ];

        const baseBinaryFiles = [
          {
            id: 'file-fig',
            name: 'fig.png',
            sizeBytes: figBytes.length,
            hash: 'a'.repeat(64),
          },
        ];

        const plan1 = planDbFileSet({
          nodes: baseNodes,
          docs: [
            {
              id: 'doc-main',
              path: '/main.tex',
              rev: 1,
              sizeBytes: 82,
              updatedAt: now,
            },
            {
              id: 'doc-ch1',
              path: '/ch1.tex',
              rev: 1,
              sizeBytes: 17,
              updatedAt: now,
            },
            {
              id: 'doc-ch2',
              path: '/ch2.tex',
              rev: 1,
              sizeBytes: 17,
              updatedAt: now,
            },
          ],
          binaryFiles: baseBinaryFiles,
          incomingFiles: {},
          source: '',
          pageId: PAGE_ID,
        });

        const docRowsById: Record<string, string[]> = {
          'doc-main': [
            '\\documentclass{article}',
            '\\input{ch1}',
            '\\input{ch2}',
            '\\begin{document}Main\\end{document}',
          ],
          'doc-ch1': ['Chapter 1 initial'],
          'doc-ch2': ['Chapter 2 initial'],
        };

        const findManyMock = jest.fn(
          async ({ where }: { where: { id: { in: string[] } } }) =>
            where.id.in.map((id) => ({
              id,
              lines: docRowsById[id] || [],
              inStorage: false,
              sizeBytes: 20,
            })),
        );
        const openReadStreamMock = jest.fn();

        const planner = new WorkspacePlannerService(
          {
            pageDoc: { findMany: findManyMock },
          } as unknown as never,
          undefined,
          { openReadStream: openReadStreamMock } as unknown as never,
          undefined,
          workspace,
        );

        // 1st hydrate: fetches all 3 docs from DB, but skips reading fig.png from disk into RAM (0-byte sentinel)
        const hydrated1 = await planner.hydrateFiles(SPACE_ID, plan1, PAGE_ID, {
          deltaOnlyOnDisk: true,
        });
        expect(findManyMock).toHaveBeenCalledTimes(1);
        expect(findManyMock.mock.calls[0][0].where.id.in.sort()).toEqual([
          'doc-ch1',
          'doc-ch2',
          'doc-main',
        ]);
        expect(openReadStreamMock).not.toHaveBeenCalled();
        expect(Buffer.isBuffer(hydrated1['fig.png'])).toBe(true);
        expect((hydrated1['fig.png'] as Buffer).byteLength).toBe(0);

        // 2nd hydrate: User 2 edits ONLY ch2.tex (rev 1 -> 2).
        // findManyMock must query ONLY ['doc-ch2'] (O(Delta D) = 1 doc instead of 3)!
        docRowsById['doc-ch2'] = ['Chapter 2 updated by User 2'];
        const plan2 = planDbFileSet({
          nodes: baseNodes,
          docs: [
            {
              id: 'doc-main',
              path: '/main.tex',
              rev: 1,
              sizeBytes: 82,
              updatedAt: now,
            },
            {
              id: 'doc-ch1',
              path: '/ch1.tex',
              rev: 1,
              sizeBytes: 17,
              updatedAt: now,
            },
            {
              id: 'doc-ch2',
              path: '/ch2.tex',
              rev: 2,
              sizeBytes: 27,
              updatedAt: new Date(now.getTime() + 1000),
            },
          ],
          binaryFiles: baseBinaryFiles,
          incomingFiles: {},
          source: '',
          pageId: PAGE_ID,
        });

        const hydrated2 = await planner.hydrateFiles(SPACE_ID, plan2, PAGE_ID, {
          deltaOnlyOnDisk: true,
        });
        expect(findManyMock).toHaveBeenCalledTimes(2);
        expect(findManyMock.mock.calls[1][0].where.id.in).toEqual(['doc-ch2']);
        expect((hydrated2['fig.png'] as Buffer).byteLength).toBe(0);

        const syncStats2 = await workspace.syncFiles(
          PAGE_ID,
          Object.entries(hydrated2).map(([p, content]) => ({
            path: p,
            content,
          })),
        );
        expect(syncStats2).toEqual({
          written: 1,
          unchanged: 3,
          deleted: 0,
        });

        // Verify on-disk fig.png was preserved intact without being overwritten by the 0-byte sentinel
        const figOnDisk = await fs.readFile(path.join(scratchDir, 'fig.png'));
        expect(figOnDisk).toEqual(figBytes);
        const ch2OnDisk = await fs.readFile(
          path.join(scratchDir, 'ch2.tex'),
          'utf8',
        );
        expect(ch2OnDisk).toBe('Chapter 2 updated by User 2');
      } finally {
        await fs.rm(tmpRoot, { recursive: true, force: true });
      }
    });
  });
});
