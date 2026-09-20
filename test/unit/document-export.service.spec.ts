import { Test, TestingModule } from '@nestjs/testing';
import { ExportService } from '../../src/modules/document/export/export.service';
import { PageService } from '../../src/modules/document/page/page.service';
import { CompilerService } from '../../src/modules/document/compiler/compiler.service';
import { AssetService } from '../../src/modules/document/asset/asset.service';
import { DocumentExportFormat } from '../../src/modules/document/export/dto/export.dto';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import * as zlib from 'zlib';

describe('Document ExportService (Overleaf-grade ZIP, Source & Auxiliary Export)', () => {
  let service: ExportService;
  let pageService: jest.Mocked<PageService>;
  let compilerService: jest.Mocked<CompilerService>;
  let assetService: jest.Mocked<AssetService>;

  const mockUserId = 'user-uuid-1111';
  const mockPageId = 'page-uuid-2222';
  const mockProjectId = 'project-uuid-3333';

  const mockPage: any = {
    id: mockPageId,
    title: 'Quantum Teleportation Paper',
    content: '\\documentclass{article}\\begin{document}Hello Quantum\\end{document}',
    projectId: mockProjectId,
    authorId: mockUserId,
    childPages: [
      {
        id: 'child-1',
        title: 'methods.tex',
        content: '\\section{Methods}\nDetailed setup.',
      },
      {
        id: 'child-2',
        title: 'references.bbl',
        content: '\\begin{thebibliography}{1}\n\\bibitem{einstein} Einstein\n\\end{thebibliography}',
      },
    ],
  };

  beforeEach(async () => {
    const mockPageService = {
      findPageById: jest.fn().mockResolvedValue(mockPage),
    };

    const mockCompilerService = {
      compile: jest.fn().mockResolvedValue({
        success: true,
        pdf: Buffer.from('%PDF-1.5 dummy content').toString('base64'),
        logs: 'This is sample LaTeX compilation log output.',
      }),
    };

    const mockAssetService = {
      getProjectAssetMap: jest.fn().mockResolvedValue({
        'figures/circuit.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]).toString('base64'),
        'styles/custom.sty': Buffer.from('\\ProvidesPackage{custom}').toString('base64'),
        'cache/build.aux': Buffer.from('\\relax').toString('base64'),
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExportService,
        { provide: PageService, useValue: mockPageService },
        { provide: CompilerService, useValue: mockCompilerService },
        { provide: AssetService, useValue: mockAssetService },
      ],
    }).compile();

    service = module.get<ExportService>(ExportService);
    pageService = module.get(PageService);
    compilerService = module.get(CompilerService);
    assetService = module.get(AssetService);
  });

  describe('exportDocument - LaTeX Bundle (.zip)', () => {
    it('packages main document, child sections, and assets into a valid .zip archive', async () => {
      const result = await service.exportDocument(mockPageId, mockUserId, {
        format: DocumentExportFormat.LATEX_BUNDLE,
      });

      expect(result.filename).toBe('quantum_teleportation_paper.zip');
      expect(result.mimeType).toBe('application/zip');
      expect(result.isBase64).toBe(true);

      const zipBuffer = Buffer.from(result.content, 'base64');
      expect(zipBuffer.length).toBe(result.sizeBytes);

      // Verify ZIP magic header
      expect(zipBuffer.readUInt32LE(0)).toBe(0x04034b50);

      // Verify EOCD signature is present
      const eocdSig = zipBuffer.indexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
      expect(eocdSig).toBeGreaterThan(0);

      // Verify total entries count includes main.tex, methods.tex, references.bbl, figures/circuit.png, styles/custom.sty, cache/build.aux
      const totalEntries = zipBuffer.readUInt16LE(eocdSig + 10);
      expect(totalEntries).toBeGreaterThanOrEqual(4);
    });

    it('creates an arXiv-compliant package when format is arxiv-zip', async () => {
      const result = await service.exportDocument(mockPageId, mockUserId, {
        format: DocumentExportFormat.ARXIV_ZIP,
      });

      expect(result.filename).toBe('arxiv-quantum_teleportation_paper.zip');
      expect(result.mimeType).toBe('application/zip');

      const zipBuffer = Buffer.from(result.content, 'base64');
      // In arXiv bundle, build.aux must be filtered out while circuit.png and references.bbl are preserved
      expect(zipBuffer.includes(Buffer.from('build.aux'))).toBe(false);
      expect(zipBuffer.includes(Buffer.from('circuit.png'))).toBe(true);
      expect(zipBuffer.includes(Buffer.from('references.bbl'))).toBe(true);
    });
  });

  describe('exportDocument - Single File Outputs', () => {
    it('exports compiled PDF when format is PDF', async () => {
      const result = await service.exportDocument(mockPageId, mockUserId, {
        format: DocumentExportFormat.PDF,
      });

      expect(result.filename).toBe('quantum_teleportation_paper.pdf');
      expect(result.mimeType).toBe('application/pdf');
      expect(result.isBase64).toBe(true);
      expect(compilerService.compile).toHaveBeenCalledWith(
        { page_id: mockPageId, project_id: mockProjectId },
        mockUserId,
      );
    });

    it('exports raw LaTeX source when format is latex-source', async () => {
      const result = await service.exportDocument(mockPageId, mockUserId, {
        format: DocumentExportFormat.LATEX_SOURCE,
      });

      expect(result.filename).toBe('quantum_teleportation_paper.tex');
      expect(result.mimeType).toBe('application/x-tex');
      expect(result.content).toContain('\\documentclass{article}');
    });

    it('exports compilation logs when format is log', async () => {
      const result = await service.exportDocument(mockPageId, mockUserId, {
        format: DocumentExportFormat.LOG,
      });

      expect(result.filename).toBe('quantum_teleportation_paper.log');
      expect(result.mimeType).toBe('text/plain');
      expect(result.content).toBe('This is sample LaTeX compilation log output.');
    });

    it('exports .bbl auxiliary file when available', async () => {
      const result = await service.exportDocument(mockPageId, mockUserId, {
        format: DocumentExportFormat.BBL,
      });

      expect(result.filename).toBe('quantum_teleportation_paper.bbl');
      expect(result.mimeType).toBe('application/x-bibtex');
      expect(result.content).toContain('\\begin{thebibliography}');
    });
  });

  describe('Validation & Error Handling', () => {
    it('throws NotFoundException when document does not exist', async () => {
      pageService.findPageById.mockResolvedValueOnce(null);

      await expect(
        service.exportDocument('unknown-id', mockUserId, {
          format: DocumentExportFormat.PDF,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException for unsupported export format', async () => {
      await expect(
        service.exportDocument(mockPageId, mockUserId, {
          format: 'invalid_format' as any,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
