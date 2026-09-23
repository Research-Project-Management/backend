import { NotFoundException } from '@nestjs/common';
import { ExportsService } from '@/modules/library/citation/application/services/exports.service';
import { CitationService } from '@/modules/library/citation/application/services/citation.service';
import { ExportsRepository } from '@/modules/library/citation/infrastructure/repositories/exports.repository';
import { ExportBibliographyUseCase } from '@/modules/library/citation/application/queries/export-bibliography.use-case';
import { CitationFacade } from '@/modules/library/citation/citation.facade';
import { LibraryFacade } from '@/modules/library/library.facade';

describe('Library Citation Export & Facade Integration (Overleaf BibTeX Parity)', () => {
  let exportsService: ExportsService;
  let exportsRepo: jest.Mocked<ExportsRepository>;
  let citationService: CitationService;
  let exportBibliographyUseCase: ExportBibliographyUseCase;
  let citationFacade: CitationFacade;
  let libraryFacade: LibraryFacade;

  const mockUserId = 'user-uuid-1111';
  const mockProjectId = 'project-uuid-2222';

  const mockItem1: any = {
    id: 'item-uuid-0001',
    itemType: 'journalArticle',
    title: 'Attention Is All You Need',
    publicationTitle: 'Advances in Neural Information Processing Systems',
    year: 2017,
    volume: '30',
    pages: '5998-6008',
    doi: '10.5555/3295222.3295349',
    url: 'https://arxiv.org/abs/1706.03762',
    citationKey: 'vaswani2017attention',
    contributors: [
      { firstName: 'Ashish', lastName: 'Vaswani', role: 'author', orderIndex: 0 },
      { firstName: 'Noam', lastName: 'Shazeer', role: 'author', orderIndex: 1 },
    ],
  };

  const mockItem2: any = {
    id: 'item-uuid-0002',
    itemType: 'book',
    title: 'Clean Architecture: A Craftsman Guide to Software Structure',
    publisher: 'Prentice Hall',
    year: 2017,
    citationKey: 'martin2017clean',
    contributors: [
      { firstName: 'Robert C.', lastName: 'Martin', role: 'author', orderIndex: 0 },
    ],
  };

  const mockItemWithoutCiteKey: any = {
    id: 'raw-uuid-0003',
    itemType: 'journalArticle',
    title: 'Deep Residual Learning for Image Recognition',
    publicationTitle: 'CVPR',
    year: 2016,
    citationKey: null,
    contributors: [
      { firstName: 'Kaiming', lastName: 'He', role: 'author', orderIndex: 0 },
    ],
  };

  beforeEach(() => {
    exportsRepo = {
      findItemsByScope: jest.fn().mockResolvedValue([mockItem1, mockItem2, mockItemWithoutCiteKey]),
      findProjectMember: jest.fn().mockResolvedValue({ role: 'member' }),
      findCollection: jest.fn(),
      findItems: jest.fn(),
      findItemById: jest.fn(),
      fetchItemsInChunks: jest.fn(),
    } as unknown as jest.Mocked<ExportsRepository>;

    citationService = new CitationService();
    exportsService = new ExportsService(exportsRepo, citationService);
    exportBibliographyUseCase = new ExportBibliographyUseCase(exportsService);
    citationFacade = new CitationFacade(citationService, exportsService);
    libraryFacade = new LibraryFacade(
      undefined,
      undefined,
      undefined,
      citationFacade,
      undefined,
    );
  });

  describe('ExportsService.exportByCitationKeys', () => {
    it('should return empty result when keys array is empty or null', async () => {
      const resultEmpty = await exportsService.exportByCitationKeys(mockUserId, []);
      expect(resultEmpty).toEqual({
        content: '',
        count: 0,
        foundKeys: [],
        missingKeys: [],
      });

      const resultNull = await exportsService.exportByCitationKeys(mockUserId, null as any);
      expect(resultNull.count).toBe(0);
      expect(exportsRepo.findItemsByScope).not.toHaveBeenCalled();
    });

    it('should normalize citation keys (case-insensitive & trimmed) and generate valid BibTeX', async () => {
      const result = await exportsService.exportByCitationKeys(
        mockUserId,
        ['  VASWANI2017ATTENTION  ', 'martin2017clean'],
      );

      expect(result.count).toBe(2);
      expect(result.foundKeys).toEqual(['vaswani2017attention', 'martin2017clean']);
      expect(result.missingKeys).toHaveLength(0);

      // Verify BibTeX formatting
      expect(result.content).toContain('@article{vaswani2017attention,');
      expect(result.content).toContain('Attention');
      expect(result.content).toContain('Vaswani, Ashish and Shazeer, Noam');
      expect(result.content).toContain('year = {2017}');
      expect(result.content).toContain('@book{martin2017clean,');
      expect(result.content).toContain('Clean');
      expect(result.content).toContain('Architecture');
    });

    it('should correctly partition foundKeys and missingKeys for partial matches', async () => {
      const result = await exportsService.exportByCitationKeys(
        mockUserId,
        ['vaswani2017attention', 'non_existent_key_999'],
      );

      expect(result.count).toBe(1);
      expect(result.foundKeys).toEqual(['vaswani2017attention']);
      expect(result.missingKeys).toEqual(['non_existent_key_999']);
      expect(result.content).toContain('@article{vaswani2017attention,');
      expect(result.content).not.toContain('non_existent_key_999');
    });

    it('should fallback to matching by item id if citationKey is null/missing', async () => {
      const result = await exportsService.exportByCitationKeys(
        mockUserId,
        ['raw-uuid-0003'],
      );

      expect(result.count).toBe(1);
      expect(result.foundKeys).toEqual(['raw-uuid-0003']);
      expect(result.missingKeys).toHaveLength(0);
      expect(result.content).toContain('Deep');
      expect(result.content).toContain('Residual');
      expect(result.content).toContain('He, Kaiming');
    });

    it('should enforce project membership check when projectId is specified', async () => {
      exportsRepo.findProjectMember.mockResolvedValueOnce(null as any);

      await expect(
        exportsService.exportByCitationKeys(
          mockUserId,
          ['vaswani2017attention'],
          'unauthorized-project-id',
        ),
      ).rejects.toThrow(NotFoundException);

      expect(exportsRepo.findProjectMember).toHaveBeenCalledWith(
        'unauthorized-project-id',
        mockUserId,
      );
    });

    it('should scope database query strictly to projectId when authorized', async () => {
      await exportsService.exportByCitationKeys(
        mockUserId,
        ['vaswani2017attention'],
        mockProjectId,
      );

      expect(exportsRepo.findItemsByScope).toHaveBeenCalledWith({
        projectId: mockProjectId,
        deletedAt: null,
      });
    });

    it('should scope database query to user and user project memberships when projectId is absent', async () => {
      await exportsService.exportByCitationKeys(
        mockUserId,
        ['vaswani2017attention'],
      );

      expect(exportsRepo.findItemsByScope).toHaveBeenCalledWith({
        deletedAt: null,
        OR: [
          { userId: mockUserId },
          {
            project: {
              members: {
                some: { userId: mockUserId },
              },
            },
          },
        ],
      });
    });
  });

  describe('ExportBibliographyUseCase (CQRS Query Handler)', () => {
    it('should delegate query execution to ExportsService with all parameters', async () => {
      const spy = jest.spyOn(exportsService, 'exportByCitationKeys');

      const result = await exportBibliographyUseCase.execute({
        userId: mockUserId,
        citeKeys: ['vaswani2017attention'],
        projectId: mockProjectId,
      });

      expect(spy).toHaveBeenCalledWith(
        mockUserId,
        ['vaswani2017attention'],
        mockProjectId,
      );
      expect(result).toBeDefined();
      expect(result?.count).toBe(1);
      expect(result?.foundKeys).toEqual(['vaswani2017attention']);
    });
  });

  describe('CitationFacade & LibraryFacade (Public Inter-Module Contract & Bug Fix)', () => {
    it('should forward projectId properly without hardcoding to "bibtex"', async () => {
      const spy = jest.spyOn(exportsService, 'exportByCitationKeys');

      const result = await citationFacade.exportBibliography(
        mockUserId,
        ['vaswani2017attention'],
        mockProjectId,
      );

      // Verify Bug Fix: 3rd argument must be mockProjectId, NEVER 'bibtex'
      expect(spy).toHaveBeenCalledWith(
        mockUserId,
        ['vaswani2017attention'],
        mockProjectId,
      );
      expect(result).toEqual({
        content: expect.stringContaining('@article{vaswani2017attention,'),
      });
    });

    it('should return null when no bibliography entries are matched', async () => {
      const result = await citationFacade.exportBibliography(
        mockUserId,
        ['non_existent_key'],
      );

      expect(result).toBeNull();
    });

    it('should allow LibraryFacade to invoke citation export with projectId', async () => {
      const spy = jest.spyOn(citationFacade, 'exportBibliography');

      const result = await libraryFacade.exportBibByCitationKeys(
        mockUserId,
        ['vaswani2017attention'],
        mockProjectId,
      );

      expect(spy).toHaveBeenCalledWith(
        mockUserId,
        ['vaswani2017attention'],
        mockProjectId,
      );
      expect(result?.content).toContain('@article{vaswani2017attention,');
    });

    it('should gracefully return null from LibraryFacade if CitationFacade is omitted', async () => {
      const bareLibraryFacade = new LibraryFacade();
      const result = await bareLibraryFacade.exportBibByCitationKeys(
        mockUserId,
        ['vaswani2017attention'],
      );
      expect(result).toBeNull();
    });
  });
});
