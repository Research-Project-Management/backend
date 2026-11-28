import * as zlib from 'node:zlib';
import {
  ArchiveEntryVo,
  ArchiveFileLimitExceededException,
  ArchiveManifest,
  ConvertService,
  ExportService,
  ImportService,
  ImportSummaryVo,
  InvalidZipArchiveException,
  PageArchiveAggregatorAdapter,
  PageArchiveHydratorAdapter,
  PandocAdapter,
  ZipAdapter,
  ZipSlipSecurityException,
  normalizePandocExportFormat,
  resolveExportProfile,
  resolveImportFormat,
  resolveIncludedLatexContent,
  transpileLatexDocument,
  transpileMarkdownToLatex,
  validateExtractedArchiveEntries,
} from '@/modules/pages/export-import';
import { ExportImportController } from '@/modules/pages/export-import/export-import.controller';

describe('Pages Export & Import Seam', () => {
  describe('Archive value objects, export profiles & LaTeX transpilers', () => {
    it('enforces Zip-Slip invariants, standard vs arxiv profiles, and entry limits', () => {
      expect(
        ArchiveEntryVo.create('./sections/intro.tex', Buffer.from('Hi')).path,
      ).toBe('sections/intro.tex');
      expect(() => ArchiveEntryVo.create('../etc/passwd')).toThrow(
        ZipSlipSecurityException,
      );
      expect(
        new ArchiveManifest({
          projectId: 'proj-1',
          projectName: 'paper',
          fileCount: 3,
          totalSizeBytes: 120,
        }).toJSON().projectName,
      ).toBe('paper');

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
      expect(arxiv.shouldInclude('paper.aux')).toBe(false);
      expect(arxiv.shouldInclude('paper.bbl')).toBe(true);
      expect(arxiv.includePdf).toBe(false);
      expect(arxiv.formatArchiveName('my_paper')).toBe('arxiv-my_paper');

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
    });

    it('transpiles LaTeX with \\input macros to md/html/docx and imports Markdown frontmatter', () => {
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
      expect(
        transpileLatexDocument({
          rawFilename: 'main.tex',
          content: rootTex,
          format: 'markdown',
          projectDocs: childDocs,
        }).content,
      ).toContain('# Intro');
      expect(
        transpileLatexDocument({
          rawFilename: 'main.tex',
          content: rootTex,
          format: 'html',
          projectDocs: childDocs,
        }).content,
      ).toContain('<h1>Intro</h1>');
      expect(
        transpileLatexDocument({
          rawFilename: 'main.tex',
          content: rootTex,
          format: 'docx',
        }).isBase64,
      ).toBe(true);

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

  describe('ZipAdapter security & collector/hydrator efficiency', () => {
    it('round-trips STORE/DEFLATE entries while rejecting Zip-Bomb payloads', async () => {
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

    it('defers lazy doc reads, batches getAllDocs without N+1, and prunes redundant mkdirp/duplicate paths', async () => {
      const getDoc = jest
        .fn()
        .mockResolvedValue({ lines: ['\\documentclass{article}'] });
      const getAllDocs = jest.fn().mockResolvedValue([
        { _id: 'd1', lines: ['\\documentclass{article}'] },
        { _id: 'd2', lines: ['\\section{Two}'] },
      ]);
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
        { getDoc, getAllDocs } as never,
        {} as never,
      );

      const lazyEntries = await collector.collectLazyProjectEntries(
        'space-1',
        false,
        true,
        'page-1',
      );
      expect(lazyEntries).toHaveLength(1);
      expect(getDoc).not.toHaveBeenCalled();
      expect((await lazyEntries[0].getData!())!.toString('utf8')).toBe(
        '\\documentclass{article}',
      );

      getDoc.mockClear();
      getAllDocs.mockClear();
      const eagerEntries = await collector.collectProjectEntries(
        'space-1',
        false,
        false,
        'page-1',
      );
      expect(eagerEntries).toHaveLength(2);
      expect(getAllDocs).toHaveBeenCalledTimes(1);
      expect(getDoc).not.toHaveBeenCalled();

      // Hydrator ancestor mkdirp pruning & duplicate path deduplication
      const mkdirp = jest.fn().mockResolvedValue(undefined);
      const createDoc = jest.fn(async (_proj: string, dto: { path: string }) => ({
        _id: `doc-${dto.path}`,
        version: 1,
      }));
      const hydrator = new PageArchiveHydratorAdapter(
        {
          getAllNodes: jest.fn().mockResolvedValue([]),
          mkdirp,
          createNode: jest.fn().mockResolvedValue({ id: 'node-1' }),
          autoDetectRootDoc: jest.fn().mockResolvedValue({
            id: 'node-1',
            docId: 'doc-/a/b/c/sec.tex',
            path: '/a/b/c/sec.tex',
          }),
        } as never,
        { createDoc, getDoc: jest.fn().mockResolvedValue(null) } as never,
        {} as never,
      );

      const summary = await hydrator.hydrateProjectEntries('space-1', [
        ArchiveEntryVo.create('a/', Buffer.alloc(0), true),
        ArchiveEntryVo.create('a/b/', Buffer.alloc(0), true),
        ArchiveEntryVo.create('a/b/c/sec.tex', Buffer.from('draft 1', 'utf8')),
        ArchiveEntryVo.create('a/b/c/sec.tex', Buffer.from('draft 2', 'utf8')),
      ]);
      expect(mkdirp).toHaveBeenCalledTimes(1);
      expect(mkdirp).toHaveBeenCalledWith('space-1', '/a/b/c');
      expect(createDoc).toHaveBeenCalledWith('space-1', {
        path: '/a/b/c/sec.tex',
        lines: ['draft 2'],
      });
      expect(summary.totalDocs).toBe(1);
      expect(summary.totalFolders).toBe(2);
    });
  });

  describe('Export, Import & Convert services + SSRF & multi-page isolation', () => {
    it('normalizes Pandoc formats and falls back from missing Pandoc binary to pure-TS transpiler', async () => {
      expect(normalizePandocExportFormat('word')).toBe('docx');
      expect(normalizePandocExportFormat('markdown')).toBe('md');
      expect(normalizePandocExportFormat('pdf')).toBeNull();

      const pandoc = new PandocAdapter('__nonexistent_pandoc_binary__');
      expect(
        await pandoc.exportLatex({
          rawFilename: 'main.tex',
          content: '\\section{Intro}',
          format: 'docx',
        }),
      ).toBeNull();

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
      const convertSvc = new ConvertService(
        { hydrateProjectEntries } as unknown as PageArchiveHydratorAdapter,
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
      const hydratedEntries = hydrateProjectEntries.mock
        .calls[0][1] as ArchiveEntryVo[];
      expect(hydratedEntries[0].data.toString('utf8')).toContain(
        '\\section{Markdown Heading}',
      );
    });

    it('blocks HTTP 302 SSRF redirect to loopback in ImportService.importFromUrl', async () => {
      const importSvc = new ImportService(
        { hydrateProjectEntries: jest.fn() } as unknown as PageArchiveHydratorAdapter,
        new ZipAdapter(),
      );
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

    it('creates a new Page aggregate on ZIP/convert import when pageId is omitted and honors req.resolvedPageId on routes', async () => {
      const USER_ID = '0195f000-0000-7000-8000-000000000010';
      const OLD_PAGE_ID = '0195f000-0000-7000-8000-000000000001';
      const RESOLVED_PAGE_ID = '0195f000-0000-7000-8000-000000000055';
      const pageCreate = jest.fn(async ({ data }) => data);

      const hydrator = new PageArchiveHydratorAdapter(
        {
          getAllNodes: jest.fn().mockResolvedValue([]),
          mkdirp: jest.fn().mockResolvedValue(undefined),
          createNode: jest.fn(
            async (_sid: string, dto: { docId?: string; fileId?: string; path: string }) => ({
              id: `node-${dto.path}`,
              docId: dto.docId,
              fileId: dto.fileId,
              path: dto.path,
              type: dto.docId ? 'DOC' : 'FILE',
            }),
          ),
          autoDetectRootDoc: jest.fn(
            async (_sid: string, docContents: Map<string, string[]>) => {
              const firstDocId = docContents.keys().next().value;
              return firstDocId
                ? { id: 'node-root', docId: firstDocId, path: '/main.tex' }
                : null;
            },
          ),
          setRootDoc: jest.fn(async (_sid: string, nodeId: string) => ({
            id: nodeId,
            docId: nodeId,
            path: '/main.tex',
          })),
        } as never,
        {
          createDoc: jest.fn(
            async (_spaceId: string, dto: { id?: string; path: string }) => ({
              _id: dto.id || `doc-${dto.path}`,
              version: 1,
            }),
          ),
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
          space: { upsert: jest.fn().mockResolvedValue({ id: USER_ID }) },
          page: {
            create: pageCreate,
            update: jest.fn(async ({ data }) => data),
            findFirst: jest.fn().mockResolvedValue({ id: OLD_PAGE_ID }),
          },
        } as never,
      );

      const zip = new ZipAdapter();
      const importSvc = new ImportService(hydrator, zip);
      const archiveBuf = zip.buildZip([
        { path: '__MACOSX/._main.tex', data: Buffer.from('junk') },
        {
          path: 'main.tex',
          data: Buffer.from(
            '\\documentclass{article}\n\\title{Quantum Spin Networks}\n\\begin{document}\nHi\n\\end{document}',
            'utf8',
          ),
        },
        { path: 'fig.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]) },
      ]);

      const zipResult = await importSvc.importProjectZip(
        USER_ID,
        archiveBuf,
        USER_ID,
        undefined,
        undefined,
        { fileName: 'quantum_upload.zip', createNewPage: true },
      );

      expect(pageCreate).toHaveBeenCalledTimes(1);
      expect(zipResult.pageId).not.toBe(OLD_PAGE_ID);
      expect(zipResult.rootDocId).toBe(zipResult.pageId);
      expect(zipResult.title).toBe('Quantum Spin Networks');
      expect(zipResult.skippedFiles).toEqual(['__MACOSX/._main.tex']);

      // Controller route forwarding of req.resolvedPageId
      const exportSvc = new ExportService(
        {
          collectProjectEntries: jest.fn().mockResolvedValue([]),
          collectLazyProjectEntries: jest.fn().mockResolvedValue([]),
        } as unknown as PageArchiveAggregatorAdapter,
        zip,
      );
      const exportSpaceDoc = jest.fn().mockResolvedValue({
        filename: 'main.md',
        mimeType: 'text/markdown',
        content: '# Hi',
        isBase64: false,
        sizeBytes: 4,
      });
      const importFromUrl = jest.fn().mockResolvedValue({
        filename: 'paper.tex',
        sizeBytes: 42,
        imported: true,
      });

      const controller = new ExportImportController(
        exportSvc,
        { importFromUrl } as never,
        { exportSpaceDocument: exportSpaceDoc } as never,
      );

      await controller.exportProjectByFormat(
        USER_ID,
        'md',
        undefined,
        undefined,
        USER_ID,
        { resolvedPageId: RESOLVED_PAGE_ID } as never,
      );
      expect(exportSpaceDoc).toHaveBeenCalledWith({
        spaceId: USER_ID,
        pageId: RESOLVED_PAGE_ID,
        format: 'md',
        includeChildren: undefined,
      });

      await controller.importFromUrl(
        'personal',
        { url: 'https://example.com/paper.tex', filename: 'paper.tex' },
        {
          user: { id: USER_ID },
          resolvedSpaceId: USER_ID,
          resolvedPageId: RESOLVED_PAGE_ID,
        } as never,
        null,
      );
      expect(importFromUrl).toHaveBeenCalledWith(
        USER_ID,
        'https://example.com/paper.tex',
        'paper.tex',
        RESOLVED_PAGE_ID,
        USER_ID,
      );
    });
  });
});
