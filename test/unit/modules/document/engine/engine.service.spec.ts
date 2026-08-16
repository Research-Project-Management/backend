import { Test, TestingModule } from '@nestjs/testing';
import { EngineService } from '@/modules/document/engine/engine.service';
import { LatexService } from '@/modules/document/latex/latex.service';
import { PageRepository } from '@/modules/document/page/page.repository';
import { HistoryRepository } from '@/modules/document/history/history.repository';
import { LatexEngine } from '@/modules/document/latex/dto/latex.dto';

describe('EngineService', () => {
  let service: EngineService;
  let pageRepo: PageRepository;
  let historyRepo: HistoryRepository;
  let latexService: LatexService;

  const mockPageRepo = {
    findPageById: jest.fn(),
    findPageWithVersions: jest.fn(),
    findChildPages: jest.fn(),
    updatePage: jest.fn(),
  };

  const mockHistoryRepo = {
    createVersion: jest.fn(),
    findVersionById: jest.fn(),
  };

  const mockLatexService = {
    syncProject: jest
      .fn()
      .mockResolvedValue({ ok: true, synced: 3, rootPageId: 'page-1' }),
    compile: jest
      .fn()
      .mockResolvedValue({ status: 'ok', pdf: 'JVBERi0xLjQK...', synctex: '' }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EngineService,
        { provide: PageRepository, useValue: mockPageRepo },
        { provide: HistoryRepository, useValue: mockHistoryRepo },
        { provide: LatexService, useValue: mockLatexService },
      ],
    }).compile();

    service = module.get<EngineService>(EngineService);
    pageRepo = module.get<PageRepository>(PageRepository);
    historyRepo = module.get<HistoryRepository>(HistoryRepository);
    latexService = module.get<LatexService>(LatexService);
  });

  describe('saveAndSync', () => {
    it('should save page, create a version snapshot, and trigger LaTeX project sync', async () => {
      const mockPage = {
        id: 'page-1',
        title: 'Introduction to Quantum Computing',
        content: 'Initial text',
        parentPageId: null,
        versions: [],
      };
      mockPageRepo.findPageWithVersions.mockResolvedValue(mockPage);
      mockPageRepo.updatePage.mockResolvedValue({
        ...mockPage,
        content: 'Updated draft content',
        author: {
          id: 'u-1',
          name: 'Alice',
          email: 'alice@test.com',
          avatar: null,
        },
      });
      mockHistoryRepo.createVersion.mockResolvedValue({
        id: 'ver-1',
        pageId: 'page-1',
        title: 'Introduction to Quantum Computing',
        content: 'Updated draft content',
        label: 'Auto-save snapshot',
        savedById: 'u-1',
        eventType: 'auto_save',
      });

      const result = await service.saveAndSync('page-1', 'u-1', {
        title: 'Introduction to Quantum Computing',
        content: 'Updated draft content',
      });

      expect(result.snapshotCreated).toBe(true);
      expect(result.page.content).toBe('Updated draft content');
      expect(mockLatexService.syncProject).toHaveBeenCalledWith('page-1');
    });
  });

  describe('buildDocument', () => {
    it('should assemble sections and invoke LaTeX compile proxy', async () => {
      mockPageRepo.findPageById.mockResolvedValue({
        id: 'page-1',
        title: 'Full Paper',
        content: '\\section{Abstract} This is a test paper.',
      });
      mockPageRepo.findChildPages.mockResolvedValue([
        { id: 'page-2', title: 'Methods', content: 'We used NestJS.' },
      ]);

      const result = await service.buildDocument('page-1', {
        engine: LatexEngine.PDFLATEX,
      });

      expect(result.documentId).toBe('page-1');
      expect(result.sectionsCount).toBe(1);
      expect(mockLatexService.compile).toHaveBeenCalled();
    });
  });

  describe('rollbackAndSync', () => {
    it('should restore page from version and sync compiler tree', async () => {
      mockHistoryRepo.findVersionById.mockResolvedValue({
        id: 'ver-old',
        title: 'Previous Draft',
        content: 'Previous content',
      });
      mockPageRepo.updatePage.mockResolvedValue({
        id: 'page-1',
        title: 'Previous Draft',
        content: 'Previous content',
      });

      const result = await service.rollbackAndSync('page-1', 'ver-old');
      expect(result.restoredPage.title).toBe('Previous Draft');
      expect(mockLatexService.syncProject).toHaveBeenCalledWith('page-1');
    });
  });
});
