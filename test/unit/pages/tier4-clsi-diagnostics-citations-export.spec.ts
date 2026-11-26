import * as zlib from 'zlib';
import type { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import {
  SandboxUnavailableException,
  SandboxConfigurationException,
  SandboxPolicyViolationException,
  UnsafePathException,
} from '@/modules/pages/clsi/domain/sandbox.errors';
import { ProjectLockTimeoutError } from '@/modules/pages/clsi/adapters/workspace-fs.adapters';
import { TexWordCounter } from '@/modules/pages/clsi/domain/tex-word.counter';
import { WorkspacePlannerService } from '@/modules/pages/clsi/services/workspace-planner.service';
import { ClsiService } from '@/modules/pages/clsi/services/clsi.service';
import {
  ExplanationNotFoundException,
  InvalidLogFormatException,
} from '@/modules/pages/diagnostics/domain/diagnostics.errors';
import { CompileLogAnalyzer } from '@/modules/pages/diagnostics/domain/compile-log.analyzer';
import { SyntaxLinter } from '@/modules/pages/diagnostics/domain/syntax.linter';
import {
  InvalidWordException,
  UnsupportedLanguageException,
} from '@/modules/pages/spelling/domain/spelling.errors';
import { SpellingService } from '@/modules/pages/spelling/spelling.service';
import { SpellingEngine } from '@/modules/pages/spelling/domain/spelling.engine';
import type { SpellingRepository } from '@/modules/pages/spelling/spelling.repository';
import { resolvePageControllerCoordinates } from '@/modules/pages/core/page-scope.helper';
import { formatPageByIdResponse } from '@/modules/pages/docstore/services/doc-occ.helper';
import {
  IdentifierNotFoundException,
  InvalidBibtexException,
} from '@/modules/pages/citations/domain/citations.errors';
import {
  refactorCitationKeyInLatex,
  buildBibliographySection,
  injectBibliographyIntoDocument,
} from '@/modules/pages/citations/domain/citation-operations';
import { CitationsRepository } from '@/modules/pages/citations/citations.repository';
import {
  ZipSlipSecurityException,
  ArchiveFileLimitExceededException,
  InvalidZipArchiveException,
  ArchiveSizeExceededException,
} from '@/modules/pages/export-import/domain/archive.errors';
import {
  ArchiveEntryVo,
  ImportSummaryVo,
} from '@/modules/pages/export-import/domain/archive.domain';
import {
  type IPageArchiveAggregatorPort,
  type IPageArchiveHydratorPort,
} from '@/modules/pages/export-import/domain/archive.ports';
import { ZipAdapter } from '@/modules/pages/export-import/adapters/zip.adapter';
import { ExportService } from '@/modules/pages/export-import/services/export.service';
import { ImportService } from '@/modules/pages/export-import/services/import.service';
import {
  InvalidTemplateException,
  TemplateNotFoundException,
} from '@/modules/pages/templates/domain/templates.errors';
import { TemplatesService } from '@/modules/pages/templates/templates.service';
import type { TemplatesRepository } from '@/modules/pages/templates/templates.repository';
import { GitBridgeDomainError } from '@/modules/pages/git-bridge/domain/git-bridge.types';
import { GitBridgeRepository } from '@/modules/pages/git-bridge/git-bridge.repository';
import { StructureService } from '@/modules/pages/structure/structure.service';
import {
  PageNodeEntity,
  type IStructureRepository,
} from '@/modules/pages/structure/domain';
import type { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import type { PrismaService } from '@/infrastructure/database';

const SPACE_ID = '11111111-1111-4111-8111-111111111111';
const PAGE_A_ID = '22222222-2222-4222-8222-222222222222';
const PAGE_B_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '44444444-4444-4444-8444-444444444444';

function createMockConfigService(): ConfigService {
  return {
    get: jest.fn().mockReturnValue(undefined),
  } as unknown as ConfigService;
}

describe('Khối 2 / Tầng 4 — Compiler, SyncTeX, Diagnostics, Spelling, Citations, Export & Git-Bridge', () => {
  describe('1. Domain Exception HTTP statusCode Contracts', () => {
    it('exposes accurate statusCode on all Tier 4 domain errors', () => {
      expect(new SandboxUnavailableException().statusCode).toBe(503);
      expect(new SandboxConfigurationException().statusCode).toBe(500);
      expect(new SandboxPolicyViolationException().statusCode).toBe(500);
      expect(new UnsafePathException('../etc/passwd').statusCode).toBe(400);
      expect(new ProjectLockTimeoutError(SPACE_ID, 5000).statusCode).toBe(409);
      expect(new ExplanationNotFoundException('E999').statusCode).toBe(404);
      expect(new InvalidLogFormatException().statusCode).toBe(400);
      expect(new InvalidWordException('bad', 'empty').statusCode).toBe(400);
      expect(new UnsupportedLanguageException('xx').statusCode).toBe(400);
      expect(new IdentifierNotFoundException('10.1000/x').statusCode).toBe(404);
      expect(new InvalidBibtexException().statusCode).toBe(400);
      expect(new ZipSlipSecurityException('../evil').statusCode).toBe(403);
      expect(new ArchiveFileLimitExceededException(1000).statusCode).toBe(400);
      expect(new InvalidZipArchiveException('bad').statusCode).toBe(400);
      expect(new ArchiveSizeExceededException(1024, 512).statusCode).toBe(413);
      expect(new InvalidTemplateException('bad').statusCode).toBe(400);
      expect(new TemplateNotFoundException('tpl-1').statusCode).toBe(404);
      expect(new GitBridgeDomainError('unsafe path').statusCode).toBe(400);
    });
  });

  describe('2. TexWordCounter Regression Guards', () => {
    const counter = new TexWordCounter();

    it('handles unclosed braces without hanging and ignores commented \\begin{document}', () => {
      const brokenStats = counter.count(
        '\\section{Broken heading without brace',
        'broken.tex',
      );
      expect(brokenStats.headers).toBe(1);
      expect(brokenStats.wordsInHeaders).toBe(4);

      const latex = [
        '% \\begin{document}',
        '\\documentclass{article}',
        '\\begin{document}',
        '\\section{Valid}',
        'Hello world from real body.',
        '%TC:ignore',
        'Ignored draft notes here',
        '%TC:endignore',
        '\\end{document}',
      ].join('\n');

      const stats = counter.count(latex, 'main.tex');
      expect(stats.wordsInText).toBe(5);
      expect(stats.totalWords).toBeGreaterThanOrEqual(6);
    });

    it('honors %TC:incbib directive across multi-file projects without explicit flag', () => {
      const stats = counter.countProject(
        {
          'main.tex':
            '%TC:incbib\n\\documentclass{article}\n\\begin{document}\nAlpha beta.\n\\end{document}',
          'main.bbl':
            '\\begin{thebibliography}{1}\n\\bibitem{k1} Knuth Literate Programming.\n\\end{thebibliography}',
        },
        { rootFile: 'main.tex' },
      );

      expect(stats.wordsInText).toBe(2);
      expect(stats.wordsInBibliography).toBeGreaterThan(0);
    });
  });

  describe('3. Structure, WorkspacePlanner & ClsiService Page Isolation', () => {
    it('forwards pageId through StructureService.getNodeByPath', async () => {
      const findByPath = jest.fn().mockResolvedValue(null);
      const repo = { findByPath } as unknown as IStructureRepository;
      const structure = new StructureService(repo);

      await structure.getNodeByPath(SPACE_ID, '/main.tex', PAGE_A_ID);
      expect(findByPath).toHaveBeenCalledWith(SPACE_ID, '/main.tex', PAGE_A_ID);
    });

    it('isolates WorkspacePlannerService.planFiles and snapshot throttle keys by pageId', async () => {
      const pageANode = {
        id: 'node-a',
        pageId: PAGE_A_ID,
        docId: 'doc-a',
        fileId: null,
        path: '/main.tex',
        name: 'main.tex',
        type: 'DOC',
        page: { rootDocId: 'doc-a' },
      };
      const pageBNode = {
        id: 'node-b',
        pageId: PAGE_B_ID,
        docId: 'doc-b',
        fileId: null,
        path: '/other.tex',
        name: 'other.tex',
        type: 'DOC',
        page: { rootDocId: 'doc-b' },
      };

      const createdPageIds: string[] = [];
      const mockPrisma = {
        page: {
          findUnique: jest.fn(({ where }: { where: { id: string } }) =>
            Promise.resolve({
              id: where.id,
              spaceId: SPACE_ID,
              deletedAt: null,
              rootDocId: where.id === PAGE_A_ID ? 'doc-a' : 'doc-b',
            }),
          ),
          findFirst: jest.fn(() =>
            Promise.resolve({
              id: PAGE_A_ID,
              spaceId: SPACE_ID,
              rootDocId: 'doc-a',
            }),
          ),
          findMany: jest.fn(() => Promise.resolve([])),
        },
        pageNode: {
          findMany: jest.fn().mockResolvedValue([pageANode, pageBNode]),
        },
        pageDoc: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'doc-a',
              pageId: PAGE_A_ID,
              lastKnownPath: '/main.tex',
              rev: 1,
              sizeBytes: 10,
              updatedAt: new Date(),
              inStorage: false,
            },
            {
              id: 'doc-b',
              pageId: PAGE_B_ID,
              lastKnownPath: '/other.tex',
              rev: 1,
              sizeBytes: 10,
              updatedAt: new Date(),
              inStorage: false,
            },
          ]),
        },
        pageFile: {
          findMany: jest.fn().mockResolvedValue([]),
        },
        pageSnapshot: {
          findFirst: jest.fn().mockResolvedValue({ version: 0 }),
          create: jest.fn((args: { data: { pageId: string } }) => {
            createdPageIds.push(args.data.pageId);
            return Promise.resolve({ id: `snap-${args.data.pageId}` });
          }),
        },
      } as unknown as PrismaService;

      const planner = new WorkspacePlannerService(mockPrisma);
      const planA = await planner.planFiles(
        SPACE_ID,
        { projectId: SPACE_ID, pageId: PAGE_A_ID },
        PAGE_A_ID,
      );
      expect(planA.docs.map((d) => d.id)).toEqual(['doc-a']);

      await planner.recordCompileSnapshotIfEligible(
        SPACE_ID,
        {
          'main.tex':
            '\\documentclass{article}\n\\begin{document}A\\end{document}',
        },
        'pdflatex',
        USER_ID,
        planA,
        PAGE_A_ID,
      );
      await planner.recordCompileSnapshotIfEligible(
        SPACE_ID,
        {
          'other.tex':
            '\\documentclass{article}\n\\begin{document}B\\end{document}',
        },
        'pdflatex',
        USER_ID,
        undefined,
        PAGE_B_ID,
      );

      expect(createdPageIds).toEqual([PAGE_A_ID, PAGE_B_ID]);
    });

    it('scopes enqueueCompile jobId and getWordCount planFiles call to pageId', async () => {
      const addMock = jest.fn().mockResolvedValue({ id: 'job-1' });
      const compileQueue = { add: addMock } as unknown as Queue;
      const planFiles = jest
        .fn()
        .mockResolvedValue({ mainFile: 'main.tex', docs: [] });
      const hydrateFiles = jest.fn().mockResolvedValue({
        'main.tex': '\\begin{document}Three clean words.\\end{document}',
      });
      const planner = {
        resolvePageCompileContext: jest
          .fn()
          .mockResolvedValue({ spaceId: SPACE_ID, pageId: PAGE_A_ID }),
        planFiles,
        hydrateFiles,
      } as unknown as WorkspacePlannerService;

      const clsi = new ClsiService(
        createMockConfigService(),
        undefined,
        undefined,
        compileQueue,
        undefined,
        planner,
      );

      await clsi.enqueueCompile(
        { projectId: SPACE_ID, pageId: PAGE_A_ID },
        USER_ID,
        SPACE_ID,
      );
      expect(addMock).toHaveBeenCalledWith(
        'clsi-compile',
        expect.objectContaining({ authorizedProjectId: SPACE_ID }),
        expect.objectContaining({
          jobId: expect.stringMatching(new RegExp(`^clsi-${PAGE_A_ID}-`)),
        }),
      );

      const wc = await clsi.getWordCount(
        { projectId: SPACE_ID, pageId: PAGE_A_ID },
        SPACE_ID,
      );
      expect(wc.success).toBe(true);
      expect(planFiles).toHaveBeenCalledWith(
        SPACE_ID,
        expect.objectContaining({ pageId: PAGE_A_ID }),
        PAGE_A_ID,
      );
    });
  });

  describe('4. Diagnostics (CompileLogAnalyzer & SyntaxLinter) Bugfixes', () => {
    it('extracts Windows drive paths and quoted paren file paths from compiler logs', () => {
      const analyzer = new CompileLogAnalyzer();
      const log = [
        'This is pdfTeX, Version 3.141592653',
        '(C:\\work\\sections\\intro.tex',
        '! Undefined control sequence.',
        'l.14 \\fooBar',
        ')',
        '("chapters/my chapter.tex"',
        '! Missing $ inserted.',
        'l.22 x_1',
        ')',
      ].join('\n');

      const diagnostics = analyzer.parse(log, 'main.tex');
      expect(diagnostics.length).toBeGreaterThanOrEqual(2);
      expect(diagnostics[0].file).toContain('C:/work/sections/intro.tex');
      expect(diagnostics[1].file).toContain('chapters/my chapter.tex');
    });

    it('matches exact verbatim environment close in autoFix and handles single-line verbatim & even backslashes in lint', () => {
      const linter = new SyntaxLinter();

      const autoFixed = linter.autoFix(
        [
          '\\begin{verbatim*}',
          '\\end{verbatim} % must not close verbatim*',
          'raw_underscore_stays',
          '\\end{verbatim*}',
          'Text with _underscore',
        ].join('\n'),
      );
      expect(autoFixed.fixedSource).toContain('raw_underscore_stays');
      expect(autoFixed.fixedSource).toContain('Text with \\_underscore');

      const lintItems = linter.lint(
        [
          '\\begin{verbatim}single_line_ok\\end{verbatim}',
          'LineBreak\\\\ % comment with “smart quote” and _underscore',
        ].join('\n'),
      );
      expect(lintItems).toEqual([]);
    });
  });

  describe('5. Spelling & Page Scope Coordinates', () => {
    it('resolves Personal Space controller coordinates and excludes custom dictionary words', async () => {
      const coords = resolvePageControllerCoordinates(
        { pageId: PAGE_A_ID },
        SPACE_ID,
      );
      expect(coords).toEqual({ spaceId: SPACE_ID, pageId: PAGE_A_ID });

      const repo = {
        listWords: jest.fn().mockResolvedValue(['customtermx']),
      } as unknown as SpellingRepository;
      const spelling = new SpellingService(repo, new SpellingEngine());

      const report = await spelling.check(SPACE_ID, {
        words: ['Hello', 'customtermx', 'world'],
        language: 'en-US',
      });
      expect(report.misspelledCount).toBe(0);
    });
  });

  describe('6. Citations Domain & Repository Page Isolation', () => {
    it('refactors @smith without corrupting @smith:2020 and replaces Markdown refs preserving ## Appendix', () => {
      const refactored = refactorCitationKeyInLatex(
        'Compare @smith and @smith:2020 and \\cite{smith}.',
        'smith',
        'jones',
      );
      expect(refactored.count).toBe(2);
      expect(refactored.content).toBe(
        'Compare @jones and @smith:2020 and \\cite{jones}.',
      );

      const newSection = buildBibliographySection({
        format: 'markdown',
        styleId: 'ieee',
        citations: [{ key: 'jones', bibliography: 'Jones (2025).' }],
      });
      const injected = injectBibliographyIntoDocument({
        currentContent:
          '# Paper\n\nBody\n\n## References\n\nOld item\n\n## Appendix\n\nKeep me.',
        newSection,
        format: 'markdown',
      });
      expect(injected.nextContent).toContain('[1] Jones (2025).');
      expect(injected.nextContent).toContain('## Appendix\n\nKeep me.');
      expect(injected.nextContent).not.toContain('Old item');
    });

    it('forwards pageId to structureService.getAllNodes in CitationsRepository.collectBibFiles', async () => {
      const getAllNodes = jest.fn().mockResolvedValue([
        new PageNodeEntity({
          id: 'bib-node',
          projectId: SPACE_ID,
          spaceId: SPACE_ID,
          pageId: PAGE_A_ID,
          name: 'refs.bib',
          path: '/refs.bib',
          type: 'DOC',
          docId: 'bib-doc',
        }),
      ]);
      const repo = new CitationsRepository(
        { getAllNodes } as unknown as StructureService,
        {
          getDoc: jest
            .fn()
            .mockResolvedValue({ lines: ['@article{k, title={T}}'] }),
        } as unknown as DocstoreService,
      );

      const bibs = await repo.collectBibFiles(SPACE_ID, PAGE_A_ID);
      expect(getAllNodes).toHaveBeenCalledWith(SPACE_ID, undefined, PAGE_A_ID);
      expect(bibs).toHaveLength(1);
    });
  });

  describe('7. Export-Import ZipAdapter Security & ExportImportService Scoping', () => {
    it('preserves 0-byte non-directory files and rejects truncated ZIP slices', () => {
      const adapter = new ZipAdapter();
      const buf = adapter.buildZip([
        { path: 'empty.tex', data: Buffer.alloc(0) },
        { path: 'main.tex', data: Buffer.from('hello', 'utf8') },
      ]);
      const extracted = adapter.extractZip(buf);
      const emptyEntry = extracted.find((e) => e.path === 'empty.tex');
      expect(emptyEntry).toBeDefined();
      expect(emptyEntry?.isDirectory).toBe(false);
      expect(emptyEntry?.sizeBytes).toBe(0);

      // Truncate valid ZIP data payload right inside compressed entry bytes (keep EOCD invalid/truncated)
      const corrupted = Buffer.from(buf);
      // Overwrite central directory compressedSize of entry 1 (main.tex) to exceed buffer
      const cdIdx = corrupted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
      expect(cdIdx).toBeGreaterThan(-1);
      corrupted.writeUInt32LE(0x00ffffff, cdIdx + 20);
      expect(() => adapter.extractZip(corrupted)).toThrow(
        InvalidZipArchiveException,
      );
    });

    it('enforces post-inflate zip bomb check even when central directory lies about uncompressedSize', () => {
      const adapter = new ZipAdapter();
      const rawBombPayload = Buffer.alloc(11 * 1024 * 1024, 0x41);
      const compressedPayload = zlib.deflateRawSync(rawBombPayload);
      const fileName = Buffer.from('bomb.tex', 'utf8');

      const lfh = Buffer.alloc(30 + fileName.length);
      lfh.writeUInt32LE(0x04034b50, 0);
      lfh.writeUInt16LE(20, 4);
      lfh.writeUInt16LE(0, 6);
      lfh.writeUInt16LE(8, 8); // deflate
      lfh.writeUInt32LE(0, 14);
      lfh.writeUInt32LE(compressedPayload.length, 18);
      lfh.writeUInt32LE(10, 22); // lied tiny uncompressed size
      lfh.writeUInt16LE(fileName.length, 26);
      lfh.writeUInt16LE(0, 28);
      fileName.copy(lfh, 30);

      const cdOffset = lfh.length + compressedPayload.length;
      const cd = Buffer.alloc(46 + fileName.length);
      cd.writeUInt32LE(0x02014b50, 0);
      cd.writeUInt16LE(20, 4);
      cd.writeUInt16LE(20, 6);
      cd.writeUInt16LE(8, 10);
      cd.writeUInt32LE(compressedPayload.length, 20);
      cd.writeUInt32LE(10, 24); // lied tiny uncompressed size
      cd.writeUInt16LE(fileName.length, 28);
      cd.writeUInt32LE(0, 42);
      fileName.copy(cd, 46);

      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(0x06054b50, 0);
      eocd.writeUInt16LE(1, 8);
      eocd.writeUInt16LE(1, 10);
      eocd.writeUInt32LE(cd.length, 12);
      eocd.writeUInt32LE(cdOffset, 16);

      const crafted = Buffer.concat([lfh, compressedPayload, cd, eocd]);
      expect(() => adapter.extractZip(crafted)).toThrow(
        InvalidZipArchiveException,
      );
    });

    it('forwards pageId in ExportService collectProjectEntries and ImportService hydrateProjectEntries', async () => {
      const collectProjectEntries = jest.fn().mockResolvedValue([]);
      const hydrateProjectEntries = jest.fn().mockResolvedValue(
        new ImportSummaryVo({
          projectId: SPACE_ID,
          totalEntries: 1,
          totalDocs: 1,
          totalFiles: 0,
          totalFolders: 0,
          rootDocId: 'doc-a',
          rootDocPath: 'main.tex',
        }),
      );
      const aggregator = {
        collectProjectEntries,
        collectLazyProjectEntries: jest.fn(),
      } as unknown as IPageArchiveAggregatorPort;
      const hydrator = {
        hydrateProjectEntries,
      } as unknown as IPageArchiveHydratorPort;

      const exportSvc = new ExportService(aggregator, new ZipAdapter());
      const importSvc = new ImportService(hydrator, new ZipAdapter());

      await exportSvc.collectProjectEntries(SPACE_ID, false, true, PAGE_A_ID);
      expect(collectProjectEntries).toHaveBeenCalledWith(
        SPACE_ID,
        false,
        true,
        PAGE_A_ID,
      );

      const entries = [ArchiveEntryVo.create('main.tex', Buffer.from('x'))];
      await importSvc.hydrateProjectEntries(
        SPACE_ID,
        entries,
        USER_ID,
        'main.tex',
        PAGE_A_ID,
      );
      expect(hydrateProjectEntries).toHaveBeenCalledWith(
        SPACE_ID,
        entries,
        USER_ID,
        'main.tex',
        PAGE_A_ID,
      );
    });
  });

  describe('8. Templates & Git-Bridge Personal Space Delegation', () => {
    it('forwards pageId to repository.collectProjectTemplateFiles in TemplatesService', async () => {
      const collectProjectTemplateFiles = jest.fn().mockResolvedValue({
        'main.tex':
          '\\documentclass{article}\n\\begin{document}Hi\\end{document}',
      });
      const save = jest.fn((t: { toPlainObject: () => unknown }) =>
        Promise.resolve(t),
      );
      const repo = {
        collectProjectTemplateFiles,
        save,
      } as unknown as TemplatesRepository;
      const service = new TemplatesService(repo);

      await service.createCustomTemplate({
        name: 'Custom Page Template',
        projectId: SPACE_ID,
        pageId: PAGE_A_ID,
        mainFile: 'main.tex',
      });

      expect(collectProjectTemplateFiles).toHaveBeenCalledWith(
        SPACE_ID,
        PAGE_A_ID,
      );
    });

    it('resolves Space owner fallback and page context in GitBridgeRepository', async () => {
      const mockPrisma = {
        projectMember: { findUnique: jest.fn().mockResolvedValue(null) },
        project: { findUnique: jest.fn().mockResolvedValue(null) },
        space: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ ownerUserId: USER_ID, projectId: null }),
        },
        page: {
          findUnique: jest.fn().mockResolvedValue({
            id: PAGE_A_ID,
            spaceId: SPACE_ID,
            deletedAt: null,
          }),
        },
      } as unknown as PrismaService;

      const repo = new GitBridgeRepository(mockPrisma);
      const role = await repo.resolveProjectRole(SPACE_ID, USER_ID);
      expect(role).toBe('owner');

      const ctx = await repo.resolveRepositoryContext(PAGE_A_ID);
      expect(ctx).toEqual({ spaceId: SPACE_ID, pageId: PAGE_A_ID });
    });
  });

  describe('9. Canonical spaceId & pageId Coordinate Consistency', () => {
    it('resolves canonical spaceId coordinates and emits spaceId + pageId in formatPageByIdResponse', async () => {
      expect(
        resolvePageControllerCoordinates({
          spaceId: SPACE_ID,
          pageId: PAGE_A_ID,
        }),
      ).toEqual({ spaceId: SPACE_ID, pageId: PAGE_A_ID });

      const now = new Date('2026-10-15T00:00:00Z');
      const formatted = await formatPageByIdResponse(
        {} as unknown as DocstoreService,
        {
          id: 'doc-canonical-1',
          spaceId: SPACE_ID,
          pageId: PAGE_A_ID,
          lastKnownPath: '/main.tex',
          lines: ['\\documentclass{article}'],
          version: 2,
          rev: 3,
          ranges: {},
          hash: null,
          sizeBytes: 22,
          inStorage: false,
          storageKey: null,
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
          node: null,
        },
      );

      expect(formatted.spaceId).toBe(SPACE_ID);
      expect(formatted.pageId).toBe(PAGE_A_ID);
      expect(formatted.page.spaceId).toBe(SPACE_ID);
      expect(formatted.page.pageId).toBe(PAGE_A_ID);
    });
  });
});
