/**
 * test/unit/manuscripts-clsi.service.spec.ts
 * Unit tests for Manuscripts CLSI Service
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ClsiService } from '@/modules/manuscripts/clsi/clsi.service';
import { RedisCacheService } from '@/core/cache/redis.service';
import { ProjectLockManager } from '@/modules/manuscripts/clsi/core/adapters/workspace/project-lock.manager';
import { OverleafOutputFileFinder } from '@/modules/manuscripts/clsi/core/adapters/artifacts/output-file.finder';
import { OverleafIncrementalWorkspace } from '@/modules/manuscripts/clsi/core/adapters/workspace/incremental-workspace';
import { TexEngineDetector } from '@/modules/manuscripts/clsi/core/adapters/engines/tex-engine.detector';
import { BibBackendDetector } from '@/modules/manuscripts/clsi/core/adapters/engines/bib-backend.detector';
import { DraftModeManager } from '@/modules/manuscripts/clsi/core/adapters/engines/draft-mode.manager';
import { DiskUsageCleaner } from '@/modules/manuscripts/clsi/core/adapters/workspace/disk-usage.cleaner';
import { ClsiMetrics } from '@/modules/manuscripts/clsi/core/adapters/telemetry/clsi.metrics';
import { buildZipArchive } from '@/modules/manuscripts/clsi/core/adapters/artifacts/zip.util';

describe('Manuscripts - ClsiService', () => {
  let service: ClsiService;

  const mockConfigService = {
    get: jest.fn((key: string) => {
      if (key === 'SCRATCH_DIR') return '/tmp/clsi-test-scratch';
      return null;
    }),
  };

  const mockRedisCache = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ClsiService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: RedisCacheService, useValue: mockRedisCache },
      ],
    }).compile();

    service = module.get<ClsiService>(ClsiService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('Word Count', () => {
    it('should compute academic word count statistics', () => {
      const source = `
        \\documentclass{article}
        \\title{Quantum Computing}
        \\begin{document}
        \\section{Introduction}
        This is a test of the academic manuscript word counter service.
        $E = mc^2$
        \\end{document}
      `;
      const result = service.getWordCount({ source });
      expect(result.success).toBe(true);
      expect(result.stats).toBeDefined();
      expect(result.stats?.headers).toBe(1);
      expect(result.stats?.mathInlines).toBe(1);
      expect(result.stats?.wordsInText).toBeGreaterThan(5);
    });
  });

  describe('SyncTeX Coordinate Lookups', () => {
    it('should return error gracefully when SyncTeX data is not available', async () => {
      const result = await service.forwardSync({
        projectId: 'proj-non-existent',
        file: 'main.tex',
        line: 10,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('SyncTeX data not available');
    });

    it('should return error gracefully on reverseSync when SyncTeX data is missing', async () => {
      const result = await service.reverseSync({
        projectId: 'proj-non-existent',
        page: 1,
        x: 100,
        y: 200,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('SyncTeX data not available');
    });
  });

  describe('ProjectLockManager (Phase 2)', () => {
    let testDir: string;
    let lockManager: ProjectLockManager;

    beforeEach(async () => {
      testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clsi-lock-test-'));
      lockManager = new ProjectLockManager();
    });

    afterEach(async () => {
      await fs.rm(testDir, { recursive: true, force: true });
    });

    it('should acquire lock and run action sequentially without collisions', async () => {
      const order: number[] = [];
      const runAction = (id: number, delayMs: number) =>
        lockManager.runWithLock('test-proj', testDir, async () => {
          order.push(id);
          await new Promise((r) => setTimeout(r, delayMs));
        });

      await Promise.all([runAction(1, 50), runAction(2, 10)]);

      expect(order).toEqual([1, 2]);
    });

    it('should auto-break stale locks older than staleMs', async () => {
      const lockPath = path.join(testDir, '.project-lock');
      // Create a simulated stale lock
      await fs.writeFile(lockPath, JSON.stringify({ pid: 99999, acquiredAt: '2020-01-01' }));
      // Set mtime to 1 hour ago
      const past = new Date(Date.now() - 3600000);
      await fs.utimes(lockPath, past, past);

      let executed = false;
      await lockManager.runWithLock(
        'test-proj',
        testDir,
        async () => {
          executed = true;
        },
        { staleMs: 1000 }
      );

      expect(executed).toBe(true);
    });
  });

  describe('OverleafOutputFileFinder (Phase 2)', () => {
    let testDir: string;
    let finder: OverleafOutputFileFinder;

    beforeEach(async () => {
      testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clsi-finder-test-'));
      finder = new OverleafOutputFileFinder();
    });

    afterEach(async () => {
      await fs.rm(testDir, { recursive: true, force: true });
    });

    it('should discover generated outputs while excluding input files', async () => {
      // Simulate input file
      await fs.writeFile(path.join(testDir, 'main.tex'), 'input code');
      // Simulate generated files
      await fs.writeFile(path.join(testDir, 'output.pdf'), 'PDF bytes');
      await fs.writeFile(path.join(testDir, 'output.log'), 'Log text');
      await fs.writeFile(path.join(testDir, 'output.synctex.gz'), 'SyncTeX data');
      await fs.mkdir(path.join(testDir, 'figures'), { recursive: true });
      await fs.writeFile(path.join(testDir, 'figures', 'fig1.png'), 'image');

      const outputs = await finder.find(testDir, ['main.tex']);

      expect(outputs.find((f) => f.path === 'main.tex')).toBeUndefined();
      expect(outputs.find((f) => f.isMainPdf)).toBeDefined();
      expect(outputs.find((f) => f.isLog)).toBeDefined();
      expect(outputs.find((f) => f.isSynctex)).toBeDefined();
      expect(outputs.find((f) => f.path === 'figures/fig1.png')).toBeDefined();
    });
  });

  describe('OverleafIncrementalWorkspace Extraneous Purge (Phase 2)', () => {
    let baseDir: string;
    let workspace: OverleafIncrementalWorkspace;

    beforeEach(async () => {
      baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clsi-ws-test-'));
      workspace = new OverleafIncrementalWorkspace(baseDir);
    });

    afterEach(async () => {
      await fs.rm(baseDir, { recursive: true, force: true });
    });

    it('should purge old output.pdf and extraneous files while preserving aux files', async () => {
      const scratchDir = await workspace.ensureScratch('proj-1');

      // Previous compile output
      await fs.writeFile(path.join(scratchDir, 'output.pdf'), 'stale pdf');
      await fs.writeFile(path.join(scratchDir, 'output.log'), 'stale log');
      // Aux files that should be preserved for fast compilation
      await fs.writeFile(path.join(scratchDir, 'main.aux'), '\\relax');
      await fs.writeFile(path.join(scratchDir, 'refs.bbl'), 'bbl content');
      // Extraneous dangling file that should be removed
      await fs.writeFile(path.join(scratchDir, 'dangling-file.txt'), 'garbage');
      // Input file
      await fs.writeFile(path.join(scratchDir, 'main.tex'), 'tex content');

      await workspace.purgeExtraneousFiles('proj-1', ['main.tex']);

      // Check output.pdf was purged
      await expect(fs.access(path.join(scratchDir, 'output.pdf'))).rejects.toThrow();
      await expect(fs.access(path.join(scratchDir, 'output.log'))).rejects.toThrow();
      // Check extraneous file was deleted
      await expect(fs.access(path.join(scratchDir, 'dangling-file.txt'))).rejects.toThrow();
      // Check aux files and input files were preserved!
      await expect(fs.access(path.join(scratchDir, 'main.aux'))).resolves.toBeUndefined();
      await expect(fs.access(path.join(scratchDir, 'refs.bbl'))).resolves.toBeUndefined();
      await expect(fs.access(path.join(scratchDir, 'main.tex'))).resolves.toBeUndefined();
    });
  });

  describe('TexEngineDetector (Phase 3)', () => {
    it('should detect xelatex from % !TEX program = xelatex', () => {
      const source = '% !TEX program = xelatex\n\\documentclass{article}\n\\begin{document}Hi\\end{document}';
      const result = TexEngineDetector.detect(source);
      expect(result.engine).toBe('xelatex');
      expect(result.detectedFrom).toBe('magic-comment');
    });

    it('should detect lualatex from % !TeX program = lualatex', () => {
      const source = '% !TeX program = lualatex\n\\documentclass{article}\n\\begin{document}Hi\\end{document}';
      const result = TexEngineDetector.detect(source);
      expect(result.engine).toBe('lualatex');
      expect(result.detectedFrom).toBe('magic-comment');
    });

    it('should detect xelatex from fontspec package hint when engine is unspecified', () => {
      const source = '\\documentclass{article}\n\\usepackage{fontspec}\n\\begin{document}Hi\\end{document}';
      const result = TexEngineDetector.detect(source);
      expect(result.engine).toBe('xelatex');
      expect(result.detectedFrom).toBe('package-hint');
    });

    it('should auto-detect main.tex as entry point from files dictionary', () => {
      const files = {
        'chapters/ch1.tex': '\\section{Chapter 1}\nSome content',
        'document.tex': '\\documentclass{book}\n\\begin{document}\\include{chapters/ch1}\\end{document}',
      };
      const main = TexEngineDetector.detectMainFile(files);
      expect(main).toBe('document.tex');
    });
  });

  describe('BibBackendDetector (Phase 3)', () => {
    it('should detect biber when biblatex is used without backend override', async () => {
      const source = '\\documentclass{article}\n\\usepackage{biblatex}\n\\addbibresource{refs.bib}';
      const backend = await BibBackendDetector.detect(source);
      expect(backend).toBe('biber');
    });

    it('should detect bibtex when backend=bibtex is explicitly specified', async () => {
      const source = '\\documentclass{article}\n\\usepackage[backend=bibtex]{biblatex}';
      const backend = await BibBackendDetector.detect(source);
      expect(backend).toBe('bibtex');
    });

    it('should generate proper .latexmkrc configuration with shell-escape and biber', () => {
      const config = BibBackendDetector.generateLatexmkrc({
        engine: 'xelatex',
        bibBackend: 'biber',
        shellEscape: true,
      });

      expect(config).toContain("$biber = 'biber %O %S';");
      expect(config).toContain("$pdf_mode = 5;");
      expect(config).toContain("-shell-escape");
    });
  });

  describe('DraftModeManager (Phase 3)', () => {
    it('should inject \\PassOptionsToPackage{draft}{graphicx} before \\documentclass', () => {
      const source = '\\documentclass{article}\n\\usepackage{graphicx}\n\\begin{document}\\includegraphics{fig.png}\\end{document}';
      const result = DraftModeManager.apply(source, { draft: true });

      expect(result.isModified).toBe(true);
      expect(result.source).toContain('\\PassOptionsToPackage{draft}{graphicx}');
      expect(result.source.indexOf('\\PassOptionsToPackage')).toBeLessThan(result.source.indexOf('\\documentclass'));
    });

    it('should not double-inject if draft option is already present', () => {
      const source = '\\PassOptionsToPackage{draft}{graphicx}\n\\documentclass{article}';
      const result = DraftModeManager.apply(source, { draft: true });
      expect(result.isModified).toBe(false);
    });

    it('should detect shell-escape requirement when minted package is used', () => {
      const sourceWithMinted = '\\documentclass{article}\n\\usepackage{minted}\n\\begin{document}\\end{document}';
      const sourceWithoutMinted = '\\documentclass{article}\n\\usepackage{listings}\n\\begin{document}\\end{document}';

      expect(DraftModeManager.requiresShellEscape(sourceWithMinted)).toBe(true);
      expect(DraftModeManager.requiresShellEscape(sourceWithoutMinted)).toBe(false);
    });
  });

  describe('DiskUsageCleaner (Production Scale)', () => {
    let testScratch: string;
    let cleaner: DiskUsageCleaner;

    beforeEach(async () => {
      testScratch = await fs.mkdtemp(path.join(os.tmpdir(), 'clsi-cleaner-test-'));
      cleaner = new DiskUsageCleaner(testScratch);
    });

    afterEach(async () => {
      await fs.rm(testScratch, { recursive: true, force: true });
    });

    it('should clean stale projects and skip locked projects', async () => {
      const p1 = path.join(testScratch, 'stale-proj');
      const p2 = path.join(testScratch, 'locked-proj');
      await fs.mkdir(p1, { recursive: true });
      await fs.mkdir(p2, { recursive: true });

      await fs.writeFile(path.join(p1, 'output.pdf'), 'data');
      await fs.writeFile(path.join(p2, 'output.pdf'), 'data');
      // Lock p2
      await fs.writeFile(path.join(p2, '.project-lock'), JSON.stringify({ pid: process.pid }));

      // Make p1 and its files very old (10 days ago)
      const oldDate = new Date(Date.now() - 10 * 24 * 3600 * 1000);
      await fs.utimes(p1, oldDate, oldDate);
      await fs.utimes(path.join(p1, 'output.pdf'), oldDate, oldDate);

      const stats = await cleaner.cleanStaleProjects({ maxAgeMs: 5 * 24 * 3600 * 1000 });

      expect(stats.cleanedProjects).toBe(1);
      expect(stats.skippedLocked).toBe(1);
      await expect(fs.access(p1)).rejects.toThrow();
      await expect(fs.access(p2)).resolves.toBeUndefined();
    });

    it('should enforce disk quota by removing oldest projects first', async () => {
      const pOld = path.join(testScratch, 'proj-old');
      const pNew = path.join(testScratch, 'proj-new');
      await fs.mkdir(pOld, { recursive: true });
      await fs.mkdir(pNew, { recursive: true });

      await fs.writeFile(path.join(pOld, 'file.bin'), Buffer.alloc(1000));
      await fs.writeFile(path.join(pNew, 'file.bin'), Buffer.alloc(1000));

      const past = new Date(Date.now() - 50000);
      await fs.utimes(pOld, past, past);

      // Max 1500 bytes, target 1000 bytes -> should evict pOld
      const stats = await cleaner.enforceDiskQuota({ maxBytes: 1500, targetBytes: 1000 });

      expect(stats.cleanedProjects).toBe(1);
      await expect(fs.access(pOld)).rejects.toThrow();
      await expect(fs.access(pNew)).resolves.toBeUndefined();
    });
  });

  describe('ClsiMetrics (Telemetry & Observability)', () => {
    it('should aggregate metrics and emit valid Prometheus format', () => {
      const metrics = ClsiMetrics.getInstance();
      metrics.record({
        engine: 'pdflatex',
        durationMs: 450,
        success: true,
        isCached: false,
        isTimeout: false,
        pdfSizeBytes: 50000,
      });

      const summary = metrics.getSummary();
      expect(summary.totalCompiles).toBeGreaterThan(0);
      expect(summary.successfulCompiles).toBeGreaterThan(0);

      const prom = metrics.toPrometheus();
      expect(prom).toContain('clsi_compiles_total{status="success"}');
      expect(prom).toContain('clsi_compile_duration_ms_avg{engine="pdflatex"}');
    });
  });

  describe('Zip Artifact Builder (Artifacts Packaging)', () => {
    it('should create valid PKZIP archive from files', () => {
      const zipBuffer = buildZipArchive([
        { path: 'output.pdf', data: Buffer.from('fake pdf content') },
        { path: 'output.log', data: 'compile log text' },
      ]);

      expect(zipBuffer).toBeDefined();
      expect(zipBuffer.length).toBeGreaterThan(50);
      // Valid ZIP starts with PK\x03\x04
      expect(zipBuffer.readUInt32LE(0)).toBe(0x04034b50);
    });
  });

  describe('ClsiService Health Report', () => {
    it('should return system diagnostics and compiler status', async () => {
      const report = await service.getHealthReport();
      expect(report).toBeDefined();
      expect(report.status).toBeDefined();
      expect(report.compilers).toBeDefined();
      expect(report.scratchDirectory.writable).toBe(true);
    });
  });
});

