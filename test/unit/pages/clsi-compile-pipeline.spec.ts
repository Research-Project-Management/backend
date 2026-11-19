import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import type { ConfigService } from '@nestjs/config';
import { CompilePipeline } from '@/modules/pages/clsi/services/compile-pipeline.service';
import { ClsiService } from '@/modules/pages/clsi/services/clsi.service';
import { RemoteClsiClientAdapter } from '@/modules/pages/clsi/services/remote-clsi.client';
import { WorkspaceRepository } from '@/modules/pages/clsi/repositories/workspace.repository';
import { WorkspacePlannerService } from '@/modules/pages/clsi/services/workspace-planner.service';
import { planDbFileSet } from '@/modules/pages/clsi/domain/fileset.planner';
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
});
