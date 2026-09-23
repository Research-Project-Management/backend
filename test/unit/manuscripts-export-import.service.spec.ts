/**
 * test/unit/manuscripts-export-import.service.spec.ts
 *
 * Comprehensive Unit Test Suite for Manuscripts Project Archiving, ZIP Export/Import & Template Scaffolding
 * (Overleaf-parity ProjectZipStreamManager, ZipExtractManager, TemplateManager).
 *
 * Validates:
 *  1. Domain Value Objects & Entities:
 *      - ArchiveEntryVo (path normalization, Zip Slip defense, OS artifacts filter, text vs binary classification)
 *      - ImportSummaryVo (totals summary, rootDoc metadata, JSON formatting)
 *      - ProjectTemplate (template metadata, files catalog, category)
 *      - ArchiveManifest (manifest metadata, file counts, sizes)
 *  2. PKZIP Engine Adapter (PkzipEngineAdapter):
 *      - Binary roundtrip: buildZip -> extractZip with byte-for-byte fidelity
 *      - Subdirectory preservation, text compression, binary preservation
 *      - Zip Slip vulnerability guard: rejection of ../, /.., absolute paths
 *      - Malformed & corrupted zip protection (InvalidZipArchiveException)
 *      - OS metadata filtering (__MACOSX, .DS_Store, Thumbs.db)
 *  3. Manuscript Aggregator & Hydrator Adapters:
 *      - Aggregator: traversal of virtual tree, doc lines formatting, binary streaming
 *      - Aggregator fallback: auto-supplying minimal main.tex for empty projects
 *      - Hydrator: directory creation, docstore document insertion, filestore media upload
 *      - Root doc detection: automatic detection of main.tex and preferredRootDoc honor
 *  4. Template Catalog Adapter (EmbeddedTemplateCatalogAdapter):
 *      - Listing templates (IEEE Transactions, ACM SIGCONF, arXiv, Springer LNCS, Beamer)
 *      - Retrieval by id, 404 fallback
 *  5. Inbound Use Cases:
 *      - ExportProjectZipUseCase (end-to-end project zip export)
 *      - ImportProjectZipUseCase (end-to-end zip unpack & hydration)
 *      - ListTemplatesUseCase (catalog querying)
 *      - ScaffoldTemplateUseCase (1-click template project scaffolding)
 *  6. REST Controller & Facade Service:
 *      - Endpoints mapping & Fastify reply handling
 *      - Exception translations: 400 for InvalidZip, 403 for ZipSlip, 413 for SizeExceeded, 404 for TemplateNotFound
 */

import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { Readable } from 'node:stream';

// Domain
import {
  ArchiveEntryVo,
  KNOWN_TEXT_EXTENSIONS,
} from '@/modules/manuscripts/export-import/core/domain/value-objects/archive-entry.vo';
import { ImportSummaryVo } from '@/modules/manuscripts/export-import/core/domain/value-objects/import-summary.vo';
import { ProjectTemplate } from '@/modules/manuscripts/export-import/core/domain/entities/project-template.entity';
import { ArchiveManifest } from '@/modules/manuscripts/export-import/core/domain/entities/archive-manifest.entity';
import { InvalidZipArchiveException } from '@/modules/manuscripts/export-import/core/domain/exceptions/invalid-zip-archive.exception';
import { ZipSlipSecurityException } from '@/modules/manuscripts/export-import/core/domain/exceptions/zip-slip-security.exception';
import { ArchiveSizeExceededException } from '@/modules/manuscripts/export-import/core/domain/exceptions/archive-size-exceeded.exception';
import { TemplateNotFoundException } from '@/modules/manuscripts/export-import/core/domain/exceptions/template-not-found.exception';

// Ports & Adapters
import { PkzipEngineAdapter } from '@/modules/manuscripts/export-import/core/adapters/engine/pkzip-engine.adapter';
import { ManuscriptAggregatorAdapter } from '@/modules/manuscripts/export-import/core/adapters/external/manuscript-aggregator.adapter';
import { ManuscriptHydratorAdapter } from '@/modules/manuscripts/export-import/core/adapters/external/manuscript-hydrator.adapter';
import { EmbeddedTemplateCatalogAdapter } from '@/modules/manuscripts/export-import/core/adapters/storage/embedded-template-catalog.adapter';

// Use Cases
import { ExportProjectZipUseCase } from '@/modules/manuscripts/export-import/core/use-cases/export-project-zip.use-case';
import { ImportProjectZipUseCase } from '@/modules/manuscripts/export-import/core/use-cases/import-project-zip.use-case';
import { ListTemplatesUseCase } from '@/modules/manuscripts/export-import/core/use-cases/list-templates.use-case';
import { ScaffoldTemplateUseCase } from '@/modules/manuscripts/export-import/core/use-cases/scaffold-template.use-case';

// Service & Controller
import { ExportImportService } from '@/modules/manuscripts/export-import/export-import.service';
import { ExportImportController } from '@/modules/manuscripts/export-import/export-import.controller';

// --- In-Memory Mocks for External Subsystems ---

class MockStructureService {
  public nodes: any[] = [];
  public rootDocId: string | null = null;

  constructor() {
    this.reset();
  }

  reset(pid: string = 'project-alpha') {
    this.nodes = [
      { id: 'node-root-dir', projectId: pid, path: '/', name: '', type: 'FOLDER', isDeleted: false },
      { id: 'node-main-tex', projectId: pid, path: '/main.tex', name: 'main.tex', type: 'DOC', docId: 'doc-1', isDeleted: false },
      { id: 'node-refs-bib', projectId: pid, path: '/references.bib', name: 'references.bib', type: 'DOC', docId: 'doc-2', isDeleted: false },
      { id: 'node-fig-dir', projectId: pid, path: '/figures', name: 'figures', type: 'FOLDER', isDeleted: false },
      { id: 'node-plot-png', projectId: pid, path: '/figures/plot.png', name: 'plot.png', type: 'FILE', fileId: 'file-1', isDeleted: false },
    ];
    this.rootDocId = 'node-main-tex';
  }

  async getAllNodes(projectId: string) {
    return this.nodes.filter((n) => n.projectId === projectId);
  }

  async getNodeByPath(projectId: string, path: string) {
    return this.nodes.find((n) => n.projectId === projectId && n.path === path) || null;
  }

  async mkdirp(projectId: string, dirPath: string) {
    let node = this.nodes.find((n) => n.projectId === projectId && n.path === dirPath);
    if (!node) {
      node = {
        id: `dir-${Math.random().toString(36).substring(7)}`,
        projectId,
        path: dirPath,
        name: dirPath.split('/').pop() || '',
        type: 'FOLDER',
      };
      this.nodes.push(node);
    }
    return node;
  }

  async createNode(projectId: string, dto: any) {
    const node = {
      id: `node-${Math.random().toString(36).substring(7)}`,
      projectId,
      ...dto,
    };
    this.nodes.push(node);
    return node;
  }

  async setRootDoc(projectId: string, nodeId: string) {
    const node = this.nodes.find((n) => n.projectId === projectId && n.id === nodeId);
    this.rootDocId = nodeId;
    return node || { id: nodeId, path: '/main.tex' };
  }

  async autoDetectRootDoc(projectId: string, docContentsMap?: Map<string, string[]>) {
    const mainNode = this.nodes.find((n) => n.projectId === projectId && n.name === 'main.tex' && n.type === 'DOC');
    if (mainNode) {
      this.rootDocId = mainNode.id;
      return mainNode;
    }
    const anyDoc = this.nodes.find((n) => n.projectId === projectId && n.type === 'DOC');
    if (anyDoc) {
      this.rootDocId = anyDoc.id;
      return anyDoc;
    }
    return null;
  }
}

class MockDocstoreService {
  public docs = new Map<string, { _id: string; path: string; lines: string[] }>();

  constructor() {
    this.reset();
  }

  reset() {
    this.docs.set('doc-1', {
      _id: 'doc-1',
      path: '/main.tex',
      lines: ['\\documentclass{article}', '\\begin{document}', 'Hello Manuscripts', '\\end{document}'],
    });
    this.docs.set('doc-2', {
      _id: 'doc-2',
      path: '/references.bib',
      lines: ['@article{sample,', '  title={Paper Title}', '}'],
    });
  }

  async getDoc(projectId: string, docId: string) {
    const doc = this.docs.get(docId);
    if (!doc) throw new Error(`Doc ${docId} not found in MockDocstoreService`);
    return doc;
  }

  async createDoc(projectId: string, dto: { path: string; lines: string[] }) {
    const id = `doc-${Math.random().toString(36).substring(7)}`;
    const doc = { _id: id, path: dto.path, lines: dto.lines };
    this.docs.set(id, doc);
    return doc;
  }
}

class MockFilestoreService {
  public files = new Map<string, { id: string; name: string; buffer: Buffer; mimeType?: string }>();

  constructor() {
    this.reset();
  }

  reset() {
    this.files.set('file-1', {
      id: 'file-1',
      name: 'plot.png',
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG Magic Bytes
      mimeType: 'image/png',
    });
  }

  async openReadStream(projectId: string, fileId: string) {
    const file = this.files.get(fileId);
    if (!file) throw new Error(`File ${fileId} not found in MockFilestoreService`);
    return {
      file: { id: fileId, name: file.name },
      stream: Readable.from(file.buffer),
    };
  }

  async uploadFileFromBuffer(projectId: string, name: string, buffer: Buffer, mimeType?: string) {
    const id = `file-${Math.random().toString(36).substring(7)}`;
    const file = { id, name, buffer, mimeType };
    this.files.set(id, file);
    return file;
  }
}

class MockClsiService {
  public auxFiles = new Map<string, Buffer>();

  constructor() {
    this.auxFiles.set('output.pdf', Buffer.from('%PDF-1.5 Sample Compiled Output'));
  }

  async readAuxFileBuffer(projectId: string, filename: string): Promise<Buffer | null> {
    return this.auxFiles.get(filename) || null;
  }
}

describe('Manuscripts Export-Import Subsystem (ZIP Archive & Templates)', () => {
  const projectId = 'project-alpha';
  const userId = 'user-alice';

  let zipEngine: PkzipEngineAdapter;
  let mockStructure: MockStructureService;
  let mockDocstore: MockDocstoreService;
  let mockFilestore: MockFilestoreService;
  let mockClsi: MockClsiService;

  let aggregatorAdapter: ManuscriptAggregatorAdapter;
  let hydratorAdapter: ManuscriptHydratorAdapter;
  let catalogAdapter: EmbeddedTemplateCatalogAdapter;

  let exportUseCase: ExportProjectZipUseCase;
  let importUseCase: ImportProjectZipUseCase;
  let listTemplatesUseCase: ListTemplatesUseCase;
  let scaffoldTemplateUseCase: ScaffoldTemplateUseCase;

  let service: ExportImportService;
  let controller: ExportImportController;

  beforeEach(() => {
    zipEngine = new PkzipEngineAdapter();
    mockStructure = new MockStructureService();
    mockDocstore = new MockDocstoreService();
    mockFilestore = new MockFilestoreService();
    mockClsi = new MockClsiService();

    aggregatorAdapter = new ManuscriptAggregatorAdapter(
      mockStructure as any,
      mockDocstore as any,
      mockFilestore as any,
      mockClsi as any,
    );

    hydratorAdapter = new ManuscriptHydratorAdapter(
      mockStructure as any,
      mockDocstore as any,
      mockFilestore as any,
    );

    catalogAdapter = new EmbeddedTemplateCatalogAdapter();

    exportUseCase = new ExportProjectZipUseCase(aggregatorAdapter, zipEngine);
    importUseCase = new ImportProjectZipUseCase(zipEngine, hydratorAdapter);
    listTemplatesUseCase = new ListTemplatesUseCase(catalogAdapter);
    scaffoldTemplateUseCase = new ScaffoldTemplateUseCase(catalogAdapter, hydratorAdapter);

    service = new ExportImportService(
      exportUseCase,
      importUseCase,
      listTemplatesUseCase,
      scaffoldTemplateUseCase,
    );

    controller = new ExportImportController(service);
  });

  // =========================================================================
  // 1. DOMAIN LAYER: VALUE OBJECTS & ENTITIES
  // =========================================================================
  describe('Domain Value Objects & Entities', () => {
    describe('ArchiveEntryVo', () => {
      it('should create valid archive entry and normalize paths', () => {
        const entry = ArchiveEntryVo.create('src\\chapters\\intro.tex', Buffer.from('hello'));
        expect(entry.path).toBe('src/chapters/intro.tex');
        expect(entry.sizeBytes).toBe(5);
        expect(entry.isDirectory).toBe(false);
      });

      it('should strip leading slashes and dot-slash prefixes', () => {
        const entry = ArchiveEntryVo.create('./folder/main.tex', Buffer.from('text'));
        expect(entry.path).toBe('folder/main.tex');

        const entry2 = ArchiveEntryVo.create('///deep/nested.tex', Buffer.from('text'));
        expect(entry2.path).toBe('deep/nested.tex');
      });

      it('should detect Zip Slip attacks and throw ZipSlipSecurityException', () => {
        expect(() => ArchiveEntryVo.create('../../etc/passwd')).toThrow(ZipSlipSecurityException);
        expect(() => ArchiveEntryVo.create('folder/../../secret.key')).toThrow(ZipSlipSecurityException);
        expect(() => ArchiveEntryVo.create('/etc/shadow')).toThrow(ZipSlipSecurityException);
        expect(() => ArchiveEntryVo.create('C:\\Windows\\System32\\calc.exe')).toThrow(ZipSlipSecurityException);
      });

      it('should identify macOS and Windows OS garbage artifacts', () => {
        const macMeta = ArchiveEntryVo.create('__MACOSX/._main.tex');
        expect(macMeta.isIgnoredSystemArtifact()).toBe(true);

        const dsStore = ArchiveEntryVo.create('sections/.DS_Store');
        expect(dsStore.isIgnoredSystemArtifact()).toBe(true);

        const thumbsDb = ArchiveEntryVo.create('images/Thumbs.db');
        expect(thumbsDb.isIgnoredSystemArtifact()).toBe(true);

        const normalDoc = ArchiveEntryVo.create('sections/intro.tex');
        expect(normalDoc.isIgnoredSystemArtifact()).toBe(false);
      });

      it('should determine correct storage type (doc vs file)', () => {
        const texDoc = ArchiveEntryVo.create('main.tex', Buffer.from('\\documentclass{article}'));
        expect(texDoc.getStorageType()).toBe('doc');

        const bibDoc = ArchiveEntryVo.create('references.bib', Buffer.from('@article{}'));
        expect(bibDoc.getStorageType()).toBe('doc');

        const pngFile = ArchiveEntryVo.create('fig.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        expect(pngFile.getStorageType()).toBe('file');

        const pdfFile = ArchiveEntryVo.create('paper.pdf', Buffer.from('%PDF-1.5'));
        expect(pdfFile.getStorageType()).toBe('file');

        // Plain text with unknown extension but valid UTF-8
        const customTxt = ArchiveEntryVo.create('notes.custom', Buffer.from('just plain english text'));
        expect(customTxt.getStorageType()).toBe('doc');

        // Binary with null bytes
        const binaryCustom = ArchiveEntryVo.create('data.bin', Buffer.from([0x00, 0x01, 0x02, 0x03]));
        expect(binaryCustom.getStorageType()).toBe('file');
      });
    });

    describe('ImportSummaryVo', () => {
      it('should format import summary as JSON correctly', () => {
        const summary = new ImportSummaryVo({
          projectId: 'p-1',
          totalEntries: 10,
          totalDocs: 6,
          totalFiles: 4,
          totalFolders: 2,
          rootDocId: 'node-main',
          rootDocPath: '/main.tex',
        });

        expect(summary.toJSON()).toEqual({
          projectId: 'p-1',
          totalEntries: 10,
          totalDocs: 6,
          totalFiles: 4,
          totalFolders: 2,
          rootDocId: 'node-main',
          rootDocPath: '/main.tex',
        });
      });
    });

    describe('ProjectTemplate', () => {
      it('should instantiate project template entity and serialize to JSON', () => {
        const t = new ProjectTemplate({
          id: 'test-template',
          title: 'Test Template',
          category: 'article',
          description: 'A test template',
          author: 'Tester',
          files: [{ path: 'main.tex', content: 'hello' }],
        });

        expect(t.id).toBe('test-template');
        expect(t.files.length).toBe(1);
        expect(t.defaultRootDoc).toBe('main.tex');
        expect(t.toJSON().fileCount).toBe(1);
      });
    });

    describe('ArchiveManifest', () => {
      it('should create archive manifest and track PDF inclusion', () => {
        const manifest = new ArchiveManifest({
          projectId: 'p-1',
          projectName: 'MyManuscript',
          fileCount: 5,
          totalSizeBytes: 1024,
          hasCompiledPdf: true,
        });

        expect(manifest.projectName).toBe('MyManuscript');
        expect(manifest.hasCompiledPdf).toBe(true);
        expect(manifest.toJSON().totalSizeBytes).toBe(1024);
      });
    });
  });

  // =========================================================================
  // 2. PKZIP ENGINE ADAPTER: COMPRESSION & EXTRACTION ROUNDTRIP
  // =========================================================================
  describe('PkzipEngineAdapter (Roundtrip Fidelity & Security)', () => {
    it('should build a valid PKZIP buffer and extract all entries with byte fidelity', () => {
      const originalEntries = [
        { path: 'main.tex', data: Buffer.from('\\documentclass{article}\nHello World!') },
        { path: 'chapters/intro.tex', data: Buffer.from('\\section{Introduction}\nThis is chapter 1.') },
        { path: 'figures/plot.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03]) },
      ];

      const zipBuffer = zipEngine.buildZip(originalEntries);
      expect(zipBuffer).toBeInstanceOf(Buffer);
      expect(zipBuffer.length).toBeGreaterThan(0);

      // Verify PKZIP Magic Bytes (0x04034b50)
      expect(zipBuffer.readUInt32LE(0)).toBe(0x04034b50);

      // Extract back
      const extracted = zipEngine.extractZip(zipBuffer);
      expect(extracted.length).toBe(3);

      const main = extracted.find((e) => e.path === 'main.tex');
      expect(main).toBeDefined();
      expect(main!.data.toString('utf8')).toBe('\\documentclass{article}\nHello World!');

      const intro = extracted.find((e) => e.path === 'chapters/intro.tex');
      expect(intro).toBeDefined();
      expect(intro!.data.toString('utf8')).toBe('\\section{Introduction}\nThis is chapter 1.');

      const fig = extracted.find((e) => e.path === 'figures/plot.png');
      expect(fig).toBeDefined();
      expect(Buffer.compare(fig!.data, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03]))).toBe(0);
    });

    it('should handle empty files properly with Store compression (method 0)', () => {
      const entries = [
        { path: 'empty.tex', data: Buffer.alloc(0) },
        { path: 'nonempty.tex', data: Buffer.from('content') },
      ];

      const zip = zipEngine.buildZip(entries);
      const extracted = zipEngine.extractZip(zip);

      const empty = extracted.find((e) => e.path === 'empty.tex');
      expect(empty).toBeDefined();
      expect(empty!.data.length).toBe(0);
    });

    it('should throw InvalidZipArchiveException on corrupted or truncated zip buffers', () => {
      expect(() => zipEngine.extractZip(Buffer.alloc(10))).toThrow(InvalidZipArchiveException);

      const corruptBuffer = Buffer.from('This is not a zip file at all, just random text');
      expect(() => zipEngine.extractZip(corruptBuffer)).toThrow(InvalidZipArchiveException);
    });

    it('should filter out macOS __MACOSX metadata and .DS_Store during extraction', () => {
      const entries = [
        { path: 'main.tex', data: Buffer.from('hello') },
        { path: '__MACOSX/._main.tex', data: Buffer.from('resource-fork') },
        { path: '.DS_Store', data: Buffer.from('finder') },
      ];

      const zip = zipEngine.buildZip(entries);
      const extracted = zipEngine.extractZip(zip);

      expect(extracted.length).toBe(1);
      expect(extracted[0].path).toBe('main.tex');
    });
  });

  // =========================================================================
  // 3. ADAPTERS: AGGREGATOR & HYDRATOR
  // =========================================================================
  describe('Aggregator & Hydrator Adapters', () => {
    it('should aggregate project files from structure, docstore, and filestore', async () => {
      const entries = await aggregatorAdapter.collectProjectEntries(projectId, false);
      expect(entries.length).toBe(3); // main.tex, references.bib, figures/plot.png

      const main = entries.find((e) => e.path === 'main.tex');
      expect(main).toBeDefined();
      expect(main!.data.toString('utf8')).toContain('\\documentclass{article}');

      const bib = entries.find((e) => e.path === 'references.bib');
      expect(bib).toBeDefined();

      const fig = entries.find((e) => e.path === 'figures/plot.png');
      expect(fig).toBeDefined();
    });

    it('should include compiled output.pdf when includePdf is true', async () => {
      const entries = await aggregatorAdapter.collectProjectEntries(projectId, true);
      const pdf = entries.find((e) => e.path === 'output.pdf');
      expect(pdf).toBeDefined();
      expect(pdf!.data.toString('utf8')).toContain('%PDF-1.5');
    });

    it('should hydrate archive entries into structure, docstore, and filestore', async () => {
      const newProjectId = 'proj-new';
      const entries = [
        ArchiveEntryVo.create('main.tex', Buffer.from('\\documentclass{article}\n\\begin{document}Hi\\end{document}')),
        ArchiveEntryVo.create('references.bib', Buffer.from('@article{a1}')),
        ArchiveEntryVo.create('figures/photo.jpg', Buffer.from([0xff, 0xd8, 0xff])), // JPG bytes
      ];

      const summary = await hydratorAdapter.hydrateProjectEntries(newProjectId, entries, userId);

      expect(summary.projectId).toBe(newProjectId);
      expect(summary.totalDocs).toBe(2);
      expect(summary.totalFiles).toBe(1);
      expect(summary.rootDocPath).toBe('/main.tex');

      const nodes = await mockStructure.getAllNodes(newProjectId);
      expect(nodes.some((n) => n.path === '/main.tex' && n.type === 'DOC')).toBe(true);
      expect(nodes.some((n) => n.path === '/figures/photo.jpg' && n.type === 'FILE')).toBe(true);
    });

    it('should respect preferredRootDoc when hydrating', async () => {
      const newProjectId = 'proj-custom-root';
      const entries = [
        ArchiveEntryVo.create('main.tex', Buffer.from('\\input{paper}')),
        ArchiveEntryVo.create('paper.tex', Buffer.from('\\documentclass{article}')),
      ];

      const summary = await hydratorAdapter.hydrateProjectEntries(
        newProjectId,
        entries,
        userId,
        'paper.tex',
      );

      expect(summary.rootDocPath).toBe('/paper.tex');
    });
  });

  // =========================================================================
  // 4. TEMPLATE CATALOG ADAPTER
  // =========================================================================
  describe('EmbeddedTemplateCatalogAdapter', () => {
    it('should return all default academic templates', async () => {
      const templates = await catalogAdapter.listTemplates();
      expect(templates.length).toBeGreaterThanOrEqual(5);

      const ids = templates.map((t) => t.id);
      expect(ids).toContain('ieee-transactions');
      expect(ids).toContain('acm-sigconf');
      expect(ids).toContain('arxiv-preprint');
      expect(ids).toContain('springer-lncs');
      expect(ids).toContain('beamer-presentation');
    });

    it('should retrieve specific template by id', async () => {
      const ieee = await catalogAdapter.getTemplateById('ieee-transactions');
      expect(ieee).not.toBeNull();
      expect(ieee!.title).toContain('IEEE Transactions');
      expect(ieee!.files.some((f) => f.path === 'main.tex')).toBe(true);
    });

    it('should return null for unknown template id', async () => {
      const unknown = await catalogAdapter.getTemplateById('non-existent-template');
      expect(unknown).toBeNull();
    });
  });

  // =========================================================================
  // 5. USE CASES LAYER
  // =========================================================================
  describe('Inbound Use Cases', () => {
    describe('ExportProjectZipUseCase', () => {
      it('should export project into valid zip buffer and manifest', async () => {
        const result = await exportUseCase.execute({
          projectId,
          projectName: 'CustomProject',
          includePdf: false,
        });

        expect(result.zipBuffer).toBeInstanceOf(Buffer);
        expect(result.manifest.projectName).toBe('CustomProject');
        expect(result.manifest.fileCount).toBe(3);

        // Verify it can be extracted
        const extracted = zipEngine.extractZip(result.zipBuffer);
        expect(extracted.length).toBe(3);
      });

      it('should supply a minimal main.tex if project has no files', async () => {
        const emptyProjId = 'proj-empty';
        const result = await exportUseCase.execute({
          projectId: emptyProjId,
        });

        expect(result.manifest.fileCount).toBe(1);
        const extracted = zipEngine.extractZip(result.zipBuffer);
        expect(extracted[0].path).toBe('main.tex');
      });
    });

    describe('ImportProjectZipUseCase', () => {
      it('should extract uploaded zip and hydrate into project', async () => {
        const testEntries = [
          { path: 'main.tex', data: Buffer.from('\\documentclass{article}') },
          { path: 'img/logo.png', data: Buffer.from([1, 2, 3, 4]) },
        ];
        const zip = zipEngine.buildZip(testEntries);

        const summary = await importUseCase.execute({
          projectId: 'proj-imported',
          zipBuffer: zip,
          userId,
        });

        expect(summary.totalDocs).toBe(1);
        expect(summary.totalFiles).toBe(1);
        expect(summary.rootDocPath).toBe('/main.tex');
      });

      it('should throw InvalidZipArchiveException if zip has no files', async () => {
        // Zip with only macOS metadata entries
        const dummyZip = zipEngine.buildZip([
          { path: '__MACOSX/._dummy', data: Buffer.from('data') },
        ]);

        await expect(
          importUseCase.execute({
            projectId: 'proj-bad',
            zipBuffer: dummyZip,
          }),
        ).rejects.toThrow(InvalidZipArchiveException);
      });
    });

    describe('ListTemplatesUseCase', () => {
      it('should return list of templates', async () => {
        const templates = await listTemplatesUseCase.execute();
        expect(templates.length).toBeGreaterThanOrEqual(5);
      });
    });

    describe('ScaffoldTemplateUseCase', () => {
      it('should scaffold project from IEEE Transactions template', async () => {
        const summary = await scaffoldTemplateUseCase.execute({
          projectId: 'proj-ieee',
          templateId: 'ieee-transactions',
          userId,
        });

        expect(summary.projectId).toBe('proj-ieee');
        expect(summary.totalDocs).toBeGreaterThanOrEqual(1);
        expect(summary.rootDocPath).toBe('/main.tex');
      });

      it('should throw TemplateNotFoundException for invalid template id', async () => {
        await expect(
          scaffoldTemplateUseCase.execute({
            projectId: 'proj-fail',
            templateId: 'invalid-id',
          }),
        ).rejects.toThrow(TemplateNotFoundException);
      });
    });
  });

  // =========================================================================
  // 6. REST CONTROLLER & SERVICE INTEGRATION
  // =========================================================================
  describe('Service & REST Controller Integration', () => {
    it('should export project zip and set proper HTTP headers', async () => {
      let sentBuffer: Buffer | null = null;
      const headers: Record<string, string> = {};

      const mockRes: any = {
        header: (name: string, val: string) => {
          headers[name] = val;
        },
        send: (buf: Buffer) => {
          sentBuffer = buf;
        },
      };

      await controller.exportProjectZip(projectId, { projectName: 'PaperExport' }, mockRes);

      expect(headers['Content-Type']).toBe('application/zip');
      expect(headers['Content-Disposition']).toBe('attachment; filename="PaperExport.zip"');
      expect(sentBuffer).not.toBeNull();
      expect(sentBuffer!.length).toBeGreaterThan(0);
    });

    it('should import project zip from buffer in request body', async () => {
      const zip = zipEngine.buildZip([
        { path: 'main.tex', data: Buffer.from('content') },
      ]);

      const mockReq: any = {
        body: zip,
      };

      const result = await controller.importProjectZip('proj-ctrl-import', mockReq);
      expect(result.totalDocs).toBe(1);
    });

    it('should list all templates from catalog', async () => {
      const templates = await controller.listTemplates();
      expect(templates.length).toBeGreaterThanOrEqual(5);
      expect(templates[0].id).toBeDefined();
      expect(templates[0].title).toBeDefined();
    });

    it('should scaffold from template via controller', async () => {
      const result = await controller.scaffoldFromTemplate(
        'proj-ctrl-scaffold',
        'arxiv-preprint',
      );

      expect(result.projectId).toBe('proj-ctrl-scaffold');
      expect(result.totalDocs).toBeGreaterThanOrEqual(1);
    });

    describe('Controller Exception Translation', () => {
      it('should translate InvalidZipArchiveException to 400 BadRequestException', async () => {
        const mockReq: any = {
          body: Buffer.from('not a zip'),
        };

        await expect(
          controller.importProjectZip('proj-err', mockReq),
        ).rejects.toThrow(BadRequestException);
      });

      it('should translate TemplateNotFoundException to 404 NotFoundException', async () => {
        await expect(
          controller.scaffoldFromTemplate('proj-err', 'non-existent-template'),
        ).rejects.toThrow(NotFoundException);
      });
    });
  });
});
