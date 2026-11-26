import * as zlib from 'node:zlib';
import {
  ArchiveEntryVo,
  ArchiveManifest,
  ImportSummaryBuilder,
  ImportSummaryVo,
} from '@/modules/pages/export-import/domain/archive.domain';
import {
  ArchiveFileLimitExceededException,
  ArchiveSizeExceededException,
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
  LatexImportTranspiler,
  resolveImportFormat,
} from '@/modules/pages/export-import/domain/latex-import.domain';
import { ZipAdapter } from '@/modules/pages/export-import/adapters/zip.adapter';
import { PandocAdapter } from '@/modules/pages/export-import/adapters/pandoc.adapter';
import { PageArchiveAggregatorAdapter } from '@/modules/pages/export-import/adapters/collector.adapter';
import { ExportService } from '@/modules/pages/export-import/services/export.service';
import { ImportService } from '@/modules/pages/export-import/services/import.service';
import { ConvertService } from '@/modules/pages/export-import/services/convert.service';
import { ScaffoldService } from '@/modules/pages/export-import/services/scaffold.service';
import type {
  IPageArchiveAggregatorPort,
  IPageArchiveHydratorPort,
} from '@/modules/pages/export-import/domain/archive.ports';

describe('Export-Import Module — GoF Design Patterns Suite', () => {
  describe('1. Creational: Factory Methods, Immutable VOs & ImportSummaryBuilder', () => {
    it('freezes ArchiveEntryVo, ArchiveManifest, and ImportSummaryVo and enforces Zip-Slip on creation', () => {
      const entry = ArchiveEntryVo.create('./sections/intro.tex', Buffer.from('Hi'));
      expect(entry.path).toBe('sections/intro.tex');
      expect(Object.isFrozen(entry)).toBe(true);

      expect(() => ArchiveEntryVo.create('../etc/passwd')).toThrow(
        ZipSlipSecurityException,
      );

      const manifest = ArchiveManifest.create({
        projectId: 'proj-1',
        projectName: 'paper',
        fileCount: 3,
        totalSizeBytes: 120,
      });
      expect(Object.isFrozen(manifest)).toBe(true);
      expect(manifest.toJSON().projectName).toBe('paper');
    });

    it('accumulates hydration metrics via ImportSummaryBuilder', () => {
      const builder = new ImportSummaryBuilder('proj-builder', 4);
      builder
        .recordFolder()
        .recordDoc('doc-1', ['\\documentclass{article}', '\\title{Test}'])
        .recordFile()
        .withRootDoc('doc-1', '/main.tex');

      const summary = builder.build();
      expect(Object.isFrozen(summary)).toBe(true);
      expect(summary.toJSON()).toEqual({
        projectId: 'proj-builder',
        totalEntries: 4,
        totalDocs: 1,
        totalFiles: 1,
        totalFolders: 1,
        rootDocId: 'doc-1',
        rootDocPath: '/main.tex',
      });
    });
  });

  describe('2. Behavioral: ExportProfile Strategy & ArchiveValidation Chain of Responsibility', () => {
    it('resolves StandardExportProfile vs ArxivExportProfile polymorphically', () => {
      const standard = resolveExportProfile({ mode: 'standard' });
      const arxiv = resolveExportProfile({ cleanArxiv: true });

      expect(standard.shouldIncludeEntry('paper.aux')).toBe(true);
      expect(standard.shouldIncludeCompiledPdf(true)).toBe(true);
      expect(standard.formatArchiveName('my_paper')).toBe('my_paper');

      expect(arxiv.shouldIncludeEntry('paper.aux')).toBe(false);
      expect(arxiv.shouldIncludeEntry('paper.bbl')).toBe(true);
      expect(arxiv.shouldIncludeCompiledPdf(true)).toBe(false);
      expect(arxiv.formatArchiveName('my_paper')).toBe('arxiv-my_paper');
      expect(arxiv.formatArchiveName('arxiv-my_paper')).toBe('arxiv-my_paper');
    });

    it('executes NonEmpty -> EntryCount -> UncompressedSize validation chain sequentially', () => {
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

  describe('3. Behavioral: Export & Import Format Strategy Registries', () => {
    it('transpiles LaTeX with child \\input macros to md, html, docx, and tex via ExportFormatRegistry', () => {
      const rootTex = '\\documentclass{article}\n\\title{My Paper}\n\\begin{document}\n\\maketitle\n\\input{intro}\n\\end{document}';
      const childDocs = [
        { id: 'c1', path: 'intro.tex', lines: ['\\section{Intro}', 'Hello **world**'] },
      ];

      const resolved = resolveIncludedLatexContent(rootTex, childDocs);
      expect(resolved).toContain('\\section{Intro}');

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

    it('supports .md, .markdown, and .docx via ImportFormatRegistry & LatexImportTranspiler', async () => {
      expect(resolveImportFormat(undefined, 'notes.markdown')).toBe('md');
      expect(resolveImportFormat(undefined, 'report.docx')).toBe('docx');

      const transpiler = new LatexImportTranspiler(new ZipAdapter());
      const mdRes = await transpiler.transpileByFormat(
        'md',
        Buffer.from('---\ntitle: GoF Paper\n---\n# Section One\nInline **bold** text.', 'utf8'),
        'notes.markdown',
      );
      expect(mdRes.detectedTitle).toBe('GoF Paper');
      expect(mdRes.mainTex).toContain('\\section{Section One}');
      expect(mdRes.mainTex).toContain('\\textbf{bold}');
    });
  });

  describe('4. Structural: ZipAdapter Decompression Strategies & Collector Virtual Proxy', () => {
    it('round-trips STORE and DEFLATE entries while blocking Zip-Bombs', () => {
      const zip = new ZipAdapter();
      const archive = zip.buildZip([
        { path: 'empty.tex', data: Buffer.alloc(0) },
        { path: 'main.tex', data: Buffer.from('\\section{Hello}', 'utf8') },
      ]);
      const extracted = zip.extractZip(archive);
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

      expect(() =>
        zip.extractZip(Buffer.concat([lfh, compressed, cd, eocd])),
      ).toThrow(InvalidZipArchiveException);
    });

    it('defers docstore reads via Virtual Proxy in collectLazyProjectEntries until getData() is called', async () => {
      const getDoc = jest.fn().mockResolvedValue({ lines: ['\\documentclass{article}'] });
      const collector = new PageArchiveAggregatorAdapter(
        {
          getAllNodes: jest.fn().mockResolvedValue([
            { id: 'n1', path: '/main.tex', type: 'DOC', docId: 'd1', isRootDoc: true },
            { id: 'n2', path: '/main.aux', type: 'DOC', docId: 'd2', isRootDoc: false },
          ]),
        } as never,
        { getDoc } as never,
        {} as never,
      );

      const lazyEntries = await collector.collectLazyProjectEntries('space-1', false, true, 'page-1');
      expect(lazyEntries).toHaveLength(1);
      expect(lazyEntries[0].path).toBe('main.tex');
      expect(getDoc).not.toHaveBeenCalled();

      const loaded = await lazyEntries[0].getData!();
      expect(getDoc).toHaveBeenCalledWith('space-1', 'd1');
      expect(loaded.toString('utf8')).toBe('\\documentclass{article}');
    });
  });

  describe('5. Behavioral: ConvertService Chain of Responsibility & Services Port DI', () => {
    it('falls back seamlessly from PandocImportHandler to InProcessImportHandler when Pandoc returns null', async () => {
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
      const hydrator: IPageArchiveHydratorPort = { hydrateProjectEntries };
      const pandoc = new PandocAdapter('__nonexistent_pandoc_binary__');
      const convertSvc = new ConvertService(
        hydrator,
        new LatexImportTranspiler(new ZipAdapter()),
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
      const hydratedEntries = hydrateProjectEntries.mock.calls[0][1] as ArchiveEntryVo[];
      expect(hydratedEntries[0].path).toBe('main.tex');
      expect(hydratedEntries[0].data.toString('utf8')).toContain('\\section{Markdown Heading}');
    });

    it('wires ExportService, ImportService, and ScaffoldService purely via abstract Port contracts', async () => {
      const aggregator: IPageArchiveAggregatorPort = {
        collectProjectEntries: jest.fn().mockResolvedValue([]),
        collectLazyProjectEntries: jest.fn().mockResolvedValue([]),
      };
      const hydrator: IPageArchiveHydratorPort = {
        hydrateProjectEntries: jest.fn().mockResolvedValue(ImportSummaryVo.empty('space-1')),
      };

      const exportSvc = new ExportService(aggregator, new ZipAdapter());
      const out = await exportSvc.exportProjectZip('space-1', {
        cleanArxiv: true,
        projectName: 'quantum',
        pageId: 'page-1',
      });
      expect(out.manifest.projectName).toBe('arxiv-quantum');
      expect(out.manifest.fileCount).toBe(1);

      const scaffoldSvc = new ScaffoldService(hydrator, {
        getTemplate: jest.fn().mockResolvedValue({
          id: 'ieee',
          mainFile: 'main.tex',
          files: { 'main.tex': '\\documentclass{IEEEtran}' },
        }),
      } as never);
      await scaffoldSvc.scaffoldTemplate('space-1', 'ieee', 'user-1', 'page-1');
      expect(hydrator.hydrateProjectEntries).toHaveBeenCalledWith(
        'space-1',
        expect.any(Array),
        'user-1',
        'main.tex',
        'page-1',
      );

      const importSvc = new ImportService(hydrator, new ZipAdapter());
      expect(importSvc).toBeDefined();
    });
  });
});
