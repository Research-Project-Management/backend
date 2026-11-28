import * as zlib from 'node:zlib';
import {
  ArchiveEntryVo,
  ArchiveManifest,
  ImportSummaryVo,
} from '@/modules/pages/export-import/domain/archive.domain';
import {
  ArchiveFileLimitExceededException,
  InvalidZipArchiveException,
  ZipSlipSecurityException,
} from '@/modules/pages/export-import/domain/archive.errors';
import {
  resolveExportProfile,
  validateExtractedArchiveEntries,
} from '@/modules/pages/export-import/domain/archive.policy';
import {
  resolveIncludedLatexContent,
  transpileLatexDocument,
} from '@/modules/pages/export-import/domain/latex-export.domain';
import {
  resolveImportFormat,
  transpileMarkdownToLatex,
} from '@/modules/pages/export-import/domain/latex-import.domain';
import { ZipAdapter } from '@/modules/pages/export-import/adapters/zip.adapter';
import { PandocAdapter } from '@/modules/pages/export-import/adapters/pandoc.adapter';
import { PageArchiveAggregatorAdapter } from '@/modules/pages/export-import/adapters/collector.adapter';
import { PageArchiveHydratorAdapter } from '@/modules/pages/export-import/adapters/hydrator.adapter';
import { ExportService } from '@/modules/pages/export-import/services/export.service';
import { ImportService } from '@/modules/pages/export-import/services/import.service';
import { ConvertService } from '@/modules/pages/export-import/services/convert.service';
import { ExportImportController } from '@/modules/pages/export-import/export-import.controller';

describe('Export-Import Deep Module Suite', () => {
  describe('1. Domain Value Objects & Policies', () => {
    it('enforces Zip-Slip invariants on ArchiveEntryVo creation and serializes ArchiveManifest', () => {
      const entry = ArchiveEntryVo.create(
        './sections/intro.tex',
        Buffer.from('Hi'),
      );
      expect(entry.path).toBe('sections/intro.tex');

      expect(() => ArchiveEntryVo.create('../etc/passwd')).toThrow(
        ZipSlipSecurityException,
      );

      const manifest = new ArchiveManifest({
        projectId: 'proj-1',
        projectName: 'paper',
        fileCount: 3,
        totalSizeBytes: 120,
      });
      expect(manifest.toJSON().projectName).toBe('paper');
    });

    it('evaluates standard vs arxiv ExportProfile and quota validation rules', () => {
      const standard = resolveExportProfile({
        mode: 'standard',
        includePdf: true,
      });
      const arxiv = resolveExportProfile({
        cleanArxiv: true,
        includePdf: true,
      });

      expect(standard.shouldInclude('paper.aux')).toBe(true);
      expect(standard.includePdf).toBe(true);
      expect(standard.formatArchiveName('my_paper')).toBe('my_paper');

      expect(arxiv.shouldInclude('paper.aux')).toBe(false);
      expect(arxiv.shouldInclude('paper.bbl')).toBe(true);
      expect(arxiv.includePdf).toBe(false);
      expect(arxiv.formatArchiveName('my_paper')).toBe('arxiv-my_paper');
      expect(arxiv.formatArchiveName('arxiv-my_paper')).toBe('arxiv-my_paper');

      expect(() => validateExtractedArchiveEntries([])).toThrow(
        InvalidZipArchiveException,
      );
      const twoEntries = [
        ArchiveEntryVo.create('a.tex', Buffer.from('a')),
        ArchiveEntryVo.create('b.tex', Buffer.from('b')),
      ];
      expect(() => validateExtractedArchiveEntries(twoEntries, 1)).toThrow(
        ArchiveFileLimitExceededException,
      );
      expect(validateExtractedArchiveEntries(twoEntries, 5)).toHaveLength(2);
    });
  });

  describe('2. Pure LaTeX Export & Import Domain Functions', () => {
    it('transpiles LaTeX with child \\input macros to md, html, docx, and tex', () => {
      const rootTex =
        '\\documentclass{article}\n\\title{My Paper}\n\\begin{document}\n\\maketitle\n\\input{intro}\n\\end{document}';
      const childDocs = [
        {
          id: 'c1',
          path: 'intro.tex',
          lines: ['\\section{Intro}', 'Hello **world**'],
        },
      ];

      expect(resolveIncludedLatexContent(rootTex, childDocs)).toContain(
        '\\section{Intro}',
      );

      const md = transpileLatexDocument({
        rawFilename: 'main.tex',
        content: rootTex,
        format: 'markdown',
        projectDocs: childDocs,
      });
      expect(md.filename).toBe('main.md');
      expect(md.content).toContain('# Intro');

      const html = transpileLatexDocument({
        rawFilename: 'main.tex',
        content: rootTex,
        format: 'html',
        projectDocs: childDocs,
      });
      expect(html.filename).toBe('main.html');
      expect(html.content).toContain('<h1>Intro</h1>');

      const docx = transpileLatexDocument({
        rawFilename: 'main.tex',
        content: rootTex,
        format: 'docx',
      });
      expect(docx.filename).toBe('main.docx');
      expect(docx.isBase64).toBe(true);
    });

    it('supports .md, .markdown, and .docx via pure domain transpilers', () => {
      expect(resolveImportFormat(undefined, 'notes.markdown')).toBe('md');
      expect(resolveImportFormat(undefined, 'report.docx')).toBe('docx');

      const mdRes = transpileMarkdownToLatex(
        '---\ntitle: Deep Paper\n---\n# Section One\nInline **bold** text.',
        'notes.markdown',
      );
      expect(mdRes.detectedTitle).toBe('Deep Paper');
      expect(mdRes.mainTex).toContain('\\section{Section One}');
      expect(mdRes.mainTex).toContain('\\textbf{bold}');
    });
  });

  describe('3. ZipAdapter Security & Deferred Collector Streaming', () => {
    it('round-trips STORE and DEFLATE entries while blocking Zip-Bombs', async () => {
      const zip = new ZipAdapter();
      const archive = zip.buildZip([
        { path: 'empty.tex', data: Buffer.alloc(0) },
        { path: 'main.tex', data: Buffer.from('\\section{Hello}', 'utf8') },
      ]);
      const extracted = await zip.extractZip(archive);
      expect(extracted).toHaveLength(2);
      expect(extracted[1].data.toString('utf8')).toBe('\\section{Hello}');

      const bombPayload = Buffer.alloc(11 * 1024 * 1024, 0x41);
      const compressed = zlib.deflateRawSync(bombPayload);
      const nameBuf = Buffer.from('bomb.tex', 'utf8');
      const lfh = Buffer.alloc(30 + nameBuf.length);
      lfh.writeUInt32LE(0x04034b50, 0);
      lfh.writeUInt16LE(20, 4);
      lfh.writeUInt16LE(8, 8);
      lfh.writeUInt32LE(compressed.length, 18);
      lfh.writeUInt32LE(10, 22);
      lfh.writeUInt16LE(nameBuf.length, 26);
      nameBuf.copy(lfh, 30);

      const cdOffset = lfh.length + compressed.length;
      const cd = Buffer.alloc(46 + nameBuf.length);
      cd.writeUInt32LE(0x02014b50, 0);
      cd.writeUInt16LE(20, 4);
      cd.writeUInt16LE(20, 6);
      cd.writeUInt16LE(8, 10);
      cd.writeUInt32LE(compressed.length, 20);
      cd.writeUInt32LE(10, 24);
      cd.writeUInt16LE(nameBuf.length, 28);
      nameBuf.copy(cd, 46);

      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(0x06054b50, 0);
      eocd.writeUInt16LE(1, 8);
      eocd.writeUInt16LE(1, 10);
      eocd.writeUInt32LE(cd.length, 12);
      eocd.writeUInt32LE(cdOffset, 16);

      await expect(
        zip.extractZip(Buffer.concat([lfh, compressed, cd, eocd])),
      ).rejects.toThrow(InvalidZipArchiveException);
    });

    it('defers docstore reads in collectLazyProjectEntries until getData() is consumed', async () => {
      const getDoc = jest
        .fn()
        .mockResolvedValue({ lines: ['\\documentclass{article}'] });
      const collector = new PageArchiveAggregatorAdapter(
        {
          getAllNodes: jest.fn().mockResolvedValue([
            {
              id: 'n1',
              path: '/main.tex',
              type: 'DOC',
              docId: 'd1',
              isRootDoc: true,
            },
            {
              id: 'n2',
              path: '/main.aux',
              type: 'DOC',
              docId: 'd2',
              isRootDoc: false,
            },
          ]),
        } as never,
        { getDoc } as never,
        {} as never,
      );

      const lazyEntries = await collector.collectLazyProjectEntries(
        'space-1',
        false,
        true,
        'page-1',
      );
      expect(lazyEntries).toHaveLength(1);
      expect(lazyEntries[0].path).toBe('main.tex');
      expect(getDoc).not.toHaveBeenCalled();

      const loaded = await lazyEntries[0].getData!();
      expect(getDoc).toHaveBeenCalledWith('space-1', 'd1');
      expect(loaded!.toString('utf8')).toBe('\\documentclass{article}');
    });
  });

  describe('4. Deep Service Interfaces (ConvertService, ExportService, ImportService, ScaffoldService)', () => {
    it('falls back seamlessly from Pandoc CLI to pure-TS transpiler in ConvertService', async () => {
      const hydrateProjectEntries = jest.fn().mockResolvedValue(
        new ImportSummaryVo({
          projectId: 'space-1',
          totalEntries: 1,
          totalDocs: 1,
          totalFiles: 0,
          totalFolders: 0,
          rootDocId: 'doc-main',
          rootDocPath: '/main.tex',
        }),
      );
      const hydrator = {
        hydrateProjectEntries,
      } as unknown as PageArchiveHydratorAdapter;
      const pandoc = new PandocAdapter('__nonexistent_pandoc_binary__');
      const convertSvc = new ConvertService(
        hydrator,
        new ZipAdapter(),
        undefined,
        undefined,
        pandoc,
      );

      const summary = await convertSvc.convertDocument({
        projectId: 'space-1',
        fileBuffer: Buffer.from('# Markdown Heading\nBody paragraph.', 'utf8'),
        fileName: 'draft.markdown',
        pageId: 'page-9',
      });

      expect(summary.rootDocId).toBe('doc-main');
      expect(hydrateProjectEntries).toHaveBeenCalledTimes(1);
      const hydratedEntries = hydrateProjectEntries.mock
        .calls[0][1] as ArchiveEntryVo[];
      expect(hydratedEntries[0].path).toBe('main.tex');
      expect(hydratedEntries[0].data.toString('utf8')).toContain(
        '\\section{Markdown Heading}',
      );
    });

    it('exports, imports, and scaffolds through concise service interfaces', async () => {
      const aggregator = {
        collectProjectEntries: jest.fn().mockResolvedValue([]),
        collectLazyProjectEntries: jest.fn().mockResolvedValue([]),
      } as unknown as PageArchiveAggregatorAdapter;
      const hydrator = {
        hydrateProjectEntries: jest.fn().mockResolvedValue(
          new ImportSummaryVo({
            projectId: 'space-1',
            totalEntries: 1,
            totalDocs: 1,
            totalFiles: 0,
            totalFolders: 0,
            rootDocId: 'doc-1',
            rootDocPath: '/main.tex',
          }),
        ),
      } as unknown as PageArchiveHydratorAdapter;

      const exportSvc = new ExportService(aggregator, new ZipAdapter());
      const out = await exportSvc.exportProjectZip('space-1', {
        cleanArxiv: true,
        projectName: 'quantum',
        pageId: 'page-1',
      });
      expect(out.manifest.projectName).toBe('arxiv-quantum');
      expect(out.manifest.fileCount).toBe(1);

      const importSvc = new ImportService(hydrator, new ZipAdapter());
      const entry = ArchiveEntryVo.create(
        'main.tex',
        Buffer.from('\\documentclass{IEEEtran}'),
      );
      await importSvc.hydrateProjectEntries(
        'space-1',
        [entry],
        'user-1',
        'main.tex',
        'page-1',
      );
      expect(hydrator.hydrateProjectEntries).toHaveBeenCalledWith(
        'space-1',
        [entry],
        'user-1',
        'main.tex',
        'page-1',
      );
    });

    it('eliminates N+1 getDoc queries via batch getAllDocs prefetch in collector', async () => {
      const getAllDocs = jest.fn().mockResolvedValue([
        { _id: 'd1', lines: ['\\section{One}'] },
        { _id: 'd2', lines: ['\\section{Two}'] },
      ]);
      const getDoc = jest.fn();
      const collector = new PageArchiveAggregatorAdapter(
        {
          getAllNodes: jest.fn().mockResolvedValue([
            {
              id: 'n1',
              path: '/a.tex',
              type: 'DOC',
              docId: 'd1',
              isRootDoc: true,
            },
            {
              id: 'n2',
              path: '/b.tex',
              type: 'DOC',
              docId: 'd2',
              isRootDoc: false,
            },
          ]),
        } as never,
        { getAllDocs, getDoc } as never,
        {} as never,
      );

      const entries = await collector.collectProjectEntries(
        'space-1',
        false,
        false,
        'page-1',
      );
      expect(entries).toHaveLength(2);
      expect(getAllDocs).toHaveBeenCalledTimes(1);
      expect(getDoc).not.toHaveBeenCalled();
    });

    it('prunes ancestor mkdirp calls and deduplicates colliding ZIP paths in hydrator', async () => {
      const mkdirp = jest.fn().mockResolvedValue(undefined);
      const createDoc = jest
        .fn()
        .mockImplementation(async (_proj: string, dto: { path: string }) => ({
          _id: `doc-${dto.path}`,
          version: 1,
        }));
      const createNode = jest.fn().mockResolvedValue({ id: 'node-1' });
      const autoDetectRootDoc = jest.fn().mockResolvedValue({
        id: 'node-1',
        docId: 'doc-/a/b/c/sec.tex',
        path: '/a/b/c/sec.tex',
      });

      const hydrator = new PageArchiveHydratorAdapter(
        {
          getAllNodes: jest.fn().mockResolvedValue([]),
          mkdirp,
          createNode,
          autoDetectRootDoc,
        } as never,
        { createDoc, getDoc: jest.fn().mockResolvedValue(null) } as never,
        {} as never,
      );

      const entries = [
        ArchiveEntryVo.create('a/', Buffer.alloc(0), true),
        ArchiveEntryVo.create('a/b/', Buffer.alloc(0), true),
        ArchiveEntryVo.create('a/b/c/sec.tex', Buffer.from('draft 1', 'utf8')),
        ArchiveEntryVo.create('a/b/c/sec.tex', Buffer.from('draft 2', 'utf8')),
      ];

      const summary = await hydrator.hydrateProjectEntries('space-1', entries);
      expect(mkdirp).toHaveBeenCalledTimes(1);
      expect(mkdirp).toHaveBeenCalledWith('space-1', '/a/b/c');
      expect(createDoc).toHaveBeenCalledTimes(1);
      expect(createDoc).toHaveBeenCalledWith('space-1', {
        path: '/a/b/c/sec.tex',
        lines: ['draft 2'],
      });
      expect(summary.totalDocs).toBe(1);
      expect(summary.totalFolders).toBe(2);
    });

    it('blocks HTTP 302 SSRF redirect to loopback in ImportService.importFromUrl', async () => {
      const hydrator = {
        hydrateProjectEntries: jest.fn(),
      } as unknown as PageArchiveHydratorAdapter;
      const importSvc = new ImportService(hydrator, new ZipAdapter());

      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'http://127.0.0.1:6379/secret' },
        }),
      );

      await expect(
        importSvc.importFromUrl('space-1', 'https://example.com/public.tex'),
      ).rejects.toThrow('Private or loopback URLs are not permitted.');

      fetchSpy.mockRestore();
    });

    it('creates a brand-new Page aggregate when pageId is omitted on ZIP/convert import instead of overwriting oldest page', async () => {
      const USER_ID = '0195f000-0000-7000-8000-000000000010';
      const OLD_PAGE_ID = '0195f000-0000-7000-8000-000000000001';
      const spaceUpsert = jest.fn().mockResolvedValue({ id: USER_ID });
      const pageCreate = jest.fn().mockImplementation(async ({ data }) => data);
      const pageUpdate = jest.fn().mockImplementation(async ({ data }) => data);

      const createDoc = jest
        .fn()
        .mockImplementation(async (_spaceId: string, dto: { id?: string; path: string }) => ({
          _id: dto.id || `doc-${dto.path}`,
          version: 1,
        }));
      const createNode = jest.fn().mockImplementation(async (_sid: string, dto: { docId?: string; fileId?: string; path: string }) => ({
        id: `node-${dto.path}`,
        docId: dto.docId,
        fileId: dto.fileId,
        path: dto.path,
        type: dto.docId ? 'DOC' : 'FILE',
      }));
      const autoDetectRootDoc = jest
        .fn()
        .mockImplementation(async (_sid: string, docContents: Map<string, string[]>) => {
          const firstDocId = docContents.keys().next().value;
          return firstDocId
            ? { id: 'node-root', docId: firstDocId, path: '/main.tex' }
            : null;
        });

      const hydrator = new PageArchiveHydratorAdapter(
        {
          getAllNodes: jest.fn().mockResolvedValue([]),
          mkdirp: jest.fn().mockResolvedValue(undefined),
          createNode,
          autoDetectRootDoc,
          setRootDoc: jest
            .fn()
            .mockImplementation(async (_sid: string, nodeId: string) => ({
              id: nodeId,
              docId: nodeId,
              path: '/main.tex',
            })),
        } as never,
        {
          createDoc,
          getDoc: jest.fn().mockResolvedValue({ version: 1, ranges: {} }),
          updateDoc: jest.fn().mockResolvedValue({}),
        } as never,
        {
          uploadFileFromBuffer: jest.fn().mockResolvedValue({
            id: 'file-fig-1',
            hash: { getValue: () => 'a'.repeat(40) },
          }),
        } as never,
        undefined,
        undefined,
        {
          space: { upsert: spaceUpsert },
          page: {
            create: pageCreate,
            update: pageUpdate,
            findFirst: jest.fn().mockResolvedValue({ id: OLD_PAGE_ID }),
          },
        } as never,
      );

      const zip = new ZipAdapter();
      const importSvc = new ImportService(hydrator, zip);
      const convertSvc = new ConvertService(
        hydrator,
        zip,
        undefined,
        undefined,
        new PandocAdapter('__nonexistent_pandoc_binary__'),
      );

      const archiveBuf = zip.buildZip([
        {
          path: '__MACOSX/._main.tex',
          data: Buffer.from('junk'),
        },
        {
          path: 'main.tex',
          data: Buffer.from(
            '\\documentclass{article}\n\\title{Quantum Spin Networks}\n\\begin{document}\nHi\n\\end{document}',
            'utf8',
          ),
        },
        {
          path: 'fig.png',
          data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]),
        },
      ]);

      const zipResult = await importSvc.importProjectZip(
        USER_ID,
        archiveBuf,
        USER_ID,
        undefined,
        undefined,
        { fileName: 'quantum_upload.zip', createNewPage: true },
      );

      expect(spaceUpsert).toHaveBeenCalledWith({
        where: { id: USER_ID },
        create: { id: USER_ID, type: 'personal', ownerUserId: USER_ID },
        update: {},
      });
      expect(pageCreate).toHaveBeenCalledTimes(1);
      expect(zipResult.pageId).not.toBe(OLD_PAGE_ID);
      expect(zipResult.rootDocId).toBe(zipResult.pageId);
      expect(zipResult.title).toBe('Quantum Spin Networks');
      expect(zipResult.totalDocs).toBe(1);
      expect(zipResult.totalFiles).toBe(1);
      expect(zipResult.skippedFiles).toEqual(['__MACOSX/._main.tex']);

      const convertResult = await convertSvc.convertDocument({
        projectId: USER_ID,
        fileBuffer: Buffer.from('# Converted Notes\nSome text.', 'utf8'),
        fileName: 'lecture_notes.md',
        userId: USER_ID,
      });

      expect(pageCreate).toHaveBeenCalledTimes(2);
      expect(convertResult.pageId).not.toBe(zipResult.pageId);
      expect(convertResult.pageId).not.toBe(OLD_PAGE_ID);
      expect(convertResult.title).toBe('lecture_notes');
      expect(convertResult.totalDocs).toBe(1);
      expect(convertResult.skippedFiles).toEqual([]);
    });

    it('reads req.resolvedPageId on export routes when query pageId is omitted and supports 3-arg collectProjectEntries', async () => {
      const RESOLVED_PAGE_ID = '0195f000-0000-7000-8000-000000000055';
      const SPACE_ID = '0195f000-0000-7000-8000-000000000010';

      const aggregator = {
        collectProjectEntries: jest.fn().mockResolvedValue([]),
        collectLazyProjectEntries: jest.fn().mockResolvedValue([]),
      } as unknown as PageArchiveAggregatorAdapter;
      const exportSvc = new ExportService(aggregator, new ZipAdapter());

      await exportSvc.collectProjectEntries(SPACE_ID, false, RESOLVED_PAGE_ID);
      expect(aggregator.collectProjectEntries).toHaveBeenCalledWith(
        SPACE_ID,
        false,
        false,
        RESOLVED_PAGE_ID,
      );

      const exportZipStreamSpy = jest.spyOn(exportSvc, 'exportProjectZipStream');
      const exportSpaceDoc = jest.fn().mockResolvedValue({
        filename: 'main.md',
        mimeType: 'text/markdown',
        content: '# Hi',
        isBase64: false,
        sizeBytes: 4,
      });

      const controller = new ExportImportController(
        exportSvc,
        {} as never,
        { exportSpaceDocument: exportSpaceDoc } as never,
      );

      const headers = new Map<string, string>();
      const reply = {
        header: (k: string, v: string) => headers.set(k, v),
        send: jest.fn().mockResolvedValue(undefined),
      };

      await controller.exportProjectZip(
        SPACE_ID,
        {},
        reply as never,
        undefined,
        SPACE_ID,
        { resolvedPageId: RESOLVED_PAGE_ID } as never,
      );

      expect(exportZipStreamSpy).toHaveBeenCalledWith(SPACE_ID, {
        pageId: RESOLVED_PAGE_ID,
      });

      await controller.exportProjectByFormat(
        SPACE_ID,
        'md',
        undefined,
        undefined,
        SPACE_ID,
        { resolvedPageId: RESOLVED_PAGE_ID } as never,
      );

      expect(exportSpaceDoc).toHaveBeenCalledWith({
        spaceId: SPACE_ID,
        pageId: RESOLVED_PAGE_ID,
        format: 'md',
        includeChildren: undefined,
      });
    });
  });
});
