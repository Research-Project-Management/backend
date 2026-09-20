import { DocumentFacade } from '@/modules/document/document.facade';
import { PageRepository } from '@/modules/document/page/page.repository';
import { PrismaService } from '@/core/database/prisma.service';
import { PageService } from '@/modules/document/page/page.service';
import { CompilerService } from '@/modules/document/compiler/compiler.service';
import { ExportService } from '@/modules/document/export/export.service';
import { HistoryService } from '@/modules/document/history/history.service';
import { BadRequestException } from '@nestjs/common';
import { CommentStatus, SuggestionStatus } from '@prisma/client';

describe('DocumentFacade (Deep Module Boundary Seam)', () => {
  let facade: DocumentFacade;
  let mockPageRepo: jest.Mocked<PageRepository>;
  let mockPrisma: any;
  let mockPageService: jest.Mocked<PageService>;
  let mockCompilerService: jest.Mocked<CompilerService>;
  let mockExportService: jest.Mocked<ExportService>;
  let mockHistoryService: jest.Mocked<HistoryService>;

  const mockPageId = 'page-111';
  const mockProjectId = 'proj-222';
  const mockUserId = 'user-333';

  beforeEach(() => {
    mockPageRepo = {
      findPageById: jest.fn(),
      findProjectPages: jest.fn(),
      findProjectPageTree: jest.fn(),
      createPage: jest.fn(),
    } as any;

    mockPrisma = {
      page: {
        findFirst: jest.fn(),
        count: jest.fn(),
        findMany: jest.fn(),
      },
      pageComment: {
        count: jest.fn(),
      },
      pageSuggestion: {
        count: jest.fn(),
      },
      pageVersion: {
        findMany: jest.fn(),
      },
    };

    mockPageService = {
      createPage: jest.fn(),
    } as any;

    mockCompilerService = {
      buildDocument: jest.fn(),
    } as any;

    mockExportService = {
      exportDocument: jest.fn(),
    } as any;

    mockHistoryService = {
      getVersions: jest.fn(),
    } as any;

    facade = new DocumentFacade(
      mockPageRepo,
      mockPrisma as PrismaService,
      mockPageService,
      mockCompilerService,
      mockExportService,
      mockHistoryService,
    );
  });

  describe('Page Queries & Metadata', () => {
    it('should return page by ID and filter by projectId if specified', async () => {
      mockPageRepo.findPageById.mockResolvedValueOnce({
        id: mockPageId,
        projectId: mockProjectId,
        title: 'Test Page',
      } as any);

      const result = await facade.getPageById(mockPageId, mockProjectId);
      expect(result).toBeDefined();
      expect(result?.id).toBe(mockPageId);

      // Project ID mismatch
      mockPageRepo.findPageById.mockResolvedValueOnce({
        id: mockPageId,
        projectId: 'other-proj',
      } as any);

      const mismatch = await facade.getPageById(mockPageId, mockProjectId);
      expect(mismatch).toBeNull();
    });

    it('should get string page content or serialized JSON', async () => {
      mockPrisma.page.findFirst.mockResolvedValueOnce({
        content: 'Raw latex content',
      });
      const strContent = await facade.getPageContent(mockPageId);
      expect(strContent).toBe('Raw latex content');

      mockPrisma.page.findFirst.mockResolvedValueOnce({
        content: { type: 'doc', text: 'hello' },
      });
      const jsonContent = await facade.getPageContent(mockPageId);
      expect(jsonContent).toBe(JSON.stringify({ type: 'doc', text: 'hello' }));
    });

    it('should retrieve page metadata', async () => {
      mockPrisma.page.findFirst.mockResolvedValueOnce({
        id: mockPageId,
        title: 'Title',
        projectId: mockProjectId,
        isLocked: false,
      });

      const meta = await facade.getPageMetadata(mockPageId);
      expect(meta).toEqual({
        id: mockPageId,
        title: 'Title',
        projectId: mockProjectId,
        isLocked: false,
      });
    });

    it('should delegate project pages and tree queries to repo', async () => {
      mockPageRepo.findProjectPages.mockResolvedValueOnce([{ id: '1' }] as any);
      mockPageRepo.findProjectPageTree.mockResolvedValueOnce([
        { id: '2' },
      ] as any);

      const pages = await facade.getProjectPages(mockProjectId);
      const tree = await facade.getProjectPageTree(mockProjectId);

      expect(pages).toEqual([{ id: '1' }]);
      expect(tree).toEqual([{ id: '2' }]);
    });

    it('should count and search pages via prisma', async () => {
      mockPrisma.page.count.mockResolvedValueOnce(5);
      mockPrisma.page.findMany.mockResolvedValueOnce([
        { id: '1', title: 'Doc 1' },
      ]);

      const count = await facade.countProjectPages(mockProjectId);
      const search = await facade.searchPages(mockProjectId, 'Doc');

      expect(count).toBe(5);
      expect(search).toEqual([{ id: '1', title: 'Doc 1' }]);
    });
  });

  describe('Deep Bounded-Context Operations', () => {
    it('should delegate createPage to PageService', async () => {
      const dto = { title: 'New Page' };
      mockPageService.createPage.mockResolvedValueOnce({
        id: 'new-page',
      } as any);

      const created = await facade.createPage(mockProjectId, mockUserId, dto);
      expect(created).toEqual({ id: 'new-page' });
      expect(mockPageService.createPage).toHaveBeenCalledWith(
        mockProjectId,
        mockUserId,
        dto,
      );
    });

    it('should compile page through CompilerService', async () => {
      const mockResult = { success: true, pdf: 'base64pdf' };
      mockCompilerService.buildDocument.mockResolvedValueOnce(
        mockResult as any,
      );

      const res = await facade.compilePage(mockPageId, mockUserId);
      expect(res).toEqual(mockResult);
      expect(mockCompilerService.buildDocument).toHaveBeenCalledWith(
        mockPageId,
        undefined,
      );
    });

    it('should throw BadRequestException if CompilerService is missing during compilePage', async () => {
      const bareFacade = new DocumentFacade(mockPageRepo, mockPrisma);
      await expect(
        bareFacade.compilePage(mockPageId, mockUserId),
      ).rejects.toThrow(BadRequestException);
    });

    it('should export document page through ExportService', async () => {
      const mockExportResult = {
        filename: 'paper.pdf',
        mimeType: 'application/pdf',
        content: 'data',
        isBase64: true,
        sizeBytes: 100,
      };
      mockExportService.exportDocument.mockResolvedValueOnce(mockExportResult);

      const res = await facade.exportPage(mockPageId, mockUserId, {
        format: 'pdf' as any,
      });
      expect(res).toEqual(mockExportResult);
      expect(mockExportService.exportDocument).toHaveBeenCalledWith(
        mockPageId,
        mockUserId,
        { format: 'pdf' },
      );
    });

    it('should throw BadRequestException if ExportService is missing during exportPage', async () => {
      const bareFacade = new DocumentFacade(mockPageRepo, mockPrisma);
      await expect(
        bareFacade.exportPage(mockPageId, mockUserId, { format: 'pdf' as any }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should retrieve recent versions via HistoryService', async () => {
      mockHistoryService.getVersions.mockResolvedValueOnce({
        versions: [{ id: 'v1' }],
        nextCursor: null,
      } as any);

      const res = await facade.getRecentVersions(mockPageId, 5);
      expect(res.versions).toHaveLength(1);
      expect(mockHistoryService.getVersions).toHaveBeenCalledWith(mockPageId, {
        limit: 5,
      });
    });

    it('should fallback to Prisma if HistoryService is not available', async () => {
      const bareFacade = new DocumentFacade(mockPageRepo, mockPrisma);
      mockPrisma.pageVersion.findMany.mockResolvedValueOnce([
        { id: 'v-fallback' },
      ]);

      const res = await bareFacade.getRecentVersions(mockPageId, 3);
      expect(res.versions).toEqual([{ id: 'v-fallback' }]);
    });

    it('should aggregate review statistics accurately (comments + suggestions)', async () => {
      mockPrisma.pageComment.count
        .mockResolvedValueOnce(4) // open
        .mockResolvedValueOnce(2); // resolved
      mockPrisma.pageSuggestion.count
        .mockResolvedValueOnce(3) // pending
        .mockResolvedValueOnce(5); // accepted

      const stats = await facade.getReviewStats(mockPageId);

      expect(stats).toEqual({
        pageId: mockPageId,
        openComments: 4,
        resolvedComments: 2,
        pendingSuggestions: 3,
        acceptedSuggestions: 5,
        totalItems: 14,
      });

      expect(mockPrisma.pageComment.count).toHaveBeenCalledWith({
        where: {
          pageId: mockPageId,
          status: CommentStatus.open,
          deletedAt: null,
        },
      });
      expect(mockPrisma.pageSuggestion.count).toHaveBeenCalledWith({
        where: {
          pageId: mockPageId,
          status: SuggestionStatus.pending,
          deletedAt: null,
        },
      });
    });
  });
});
