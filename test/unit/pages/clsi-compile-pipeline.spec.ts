import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { HttpException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { RealtimeFacade } from '@/modules/realtime/realtime.facade';
import { CompilePipeline } from '@/modules/pages/clsi/services/compile-pipeline.service';
import { ClsiService } from '@/modules/pages/clsi/services/clsi.service';
import { CompileQueueService } from '@/modules/pages/clsi/services/compile-queue.service';
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
import type { ILatexEngine } from '@/modules/pages/clsi/domain/clsi.ports';

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

  it('CompileQueueService sheds auto-compile under queue load while allowing manual builds and preserving structured HttpException codes', async () => {
    const queue = new CompileQueueService({
      maxConcurrentCompiles: 1,
      maxQueueLength: 4,
      autoShedThreshold: 1,
      maxCompilesPerMinute: 2,
    });

    let releaseFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      void queue.schedule('proj-1', 'user-1', undefined, async () => {
        resolve();
        await new Promise<void>((done) => {
          releaseFirst = done;
        });
        return 'first-done';
      });
    });
    await firstEntered;

    let releaseSecondQueued!: () => void;
    const secondPromise = queue.schedule(
      'proj-2',
      'user-2',
      undefined,
      async () => {
        await new Promise<void>((done) => {
          releaseSecondQueued = done;
        });
        return 'second-done';
      },
      { priority: 'manual' },
    );

    // Waiting queue count is now 1 (>= autoShedThreshold=1): auto compile must shed cleanly with 429 AUTO_COMPILE_SHED
    let shedErr: unknown;
    try {
      await queue.schedule('proj-3', 'user-3', undefined, async () => 'auto', {
        priority: 'auto',
      });
    } catch (err) {
      shedErr = err;
    }
    expect(shedErr).toBeInstanceOf(HttpException);
    expect((shedErr as HttpException).getStatus()).toBe(429);
    expect((shedErr as HttpException).getResponse()).toEqual(
      expect.objectContaining({ code: 'AUTO_COMPILE_SHED' }),
    );

    // Manual compile for proj-3 is still accepted into remaining queue slots
    const thirdPromise = queue.schedule(
      'proj-3',
      'user-3',
      undefined,
      async () => 'third-manual-done',
      { priority: 'manual' },
    );

    releaseFirst();
    await new Promise((r) => setTimeout(r, 10));
    releaseSecondQueued?.();
    await expect(secondPromise).resolves.toBe('second-done');
    await expect(thirdPromise).resolves.toBe('third-manual-done');

    // Rate limit exhaustion emits structured 429 COMPILE_RATE_LIMITED
    await queue.schedule('proj-rate', 'user-rate', undefined, async () => 1);
    await queue.schedule('proj-rate', 'user-rate', undefined, async () => 2);
    let rateErr: unknown;
    try {
      await queue.schedule('proj-rate', 'user-rate', undefined, async () => 3);
    } catch (err) {
      rateErr = err;
    }
    expect(rateErr).toBeInstanceOf(HttpException);
    expect((rateErr as HttpException).getStatus()).toBe(429);
    expect((rateErr as HttpException).getResponse()).toEqual(
      expect.objectContaining({ code: 'COMPILE_RATE_LIMITED' }),
    );

    queue.onModuleDestroy();
  });

  it('ClsiService.compileInline forwards dto.priority into CompileQueueService.schedule', async () => {
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

      const fairQueue = new CompileQueueService();
      const scheduleSpy = jest.spyOn(fairQueue, 'schedule');

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
        fairQueue,
      );

      await clsi.compileInline({
        spaceId: SPACE_ID,
        pageId: PAGE_ID,
        mainFile: 'main.tex',
        priority: 'auto',
      });

      expect(scheduleSpy).toHaveBeenCalledWith(
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

  it('CompileQueueService batches rapid onLogChunk bursts bounded by maxLogChunkBytes and clears timer on settle', async () => {
    const queue = new CompileQueueService({
      maxConcurrentCompiles: 1,
      logChunkFlushIntervalMs: 30,
      maxLogChunkBytes: 64,
    });
    const broadcastMock = jest.fn();
    const realtimeMock = {
      broadcastCompileProgress: broadcastMock,
    } as unknown as RealtimeFacade;

    await queue.schedule(
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
        p.status === 'compiling' && !p.logs?.[0]?.startsWith('[CLSI Queue]')
      );
    });
    expect(chunkCalls).toHaveLength(1);
    const flushedText = (chunkCalls[0]?.[1] as { logs: string[] }).logs[0];
    expect(flushedText.length).toBeLessThanOrEqual(64);
    expect(flushedText).toContain('CHUNK_9_');
    expect(flushedText).not.toContain('TRAILING_UNFLUSHED_CHUNK');

    queue.onModuleDestroy();
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
  });
});
