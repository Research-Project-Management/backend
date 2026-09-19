import { Test, TestingModule } from '@nestjs/testing';
import { CoreService } from '@/modules/document/core/core.service';
import { CoreRepository } from '@/modules/document/core/core.repository';
import { PageStatus } from '@prisma/client';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

describe('Document CoreService (Server-Authoritative Invariants)', () => {
  let service: CoreService;
  let repo: jest.Mocked<CoreRepository>;

  const mockUserId = '11111111-1111-1111-1111-111111111111';
  const mockProjectId = '22222222-2222-2222-2222-222222222222';
  const mockPageId = '33333333-3333-3333-3333-333333333333';

  const mockPage: any = {
    id: mockPageId,
    title: 'Research Paper',
    slug: 'research-paper',
    icon: 'file-text',
    coverImage: null,
    rank: 0,
    isLocked: false,
    isPublished: false,
    content: '\\section{Introduction}\nHere is our methodology.',
    status: PageStatus.draft,
    views: 12,
    projectId: mockProjectId,
    authorId: mockUserId,
    parentPageId: null,
    mainFileId: null,
    pdfThumbnail: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    author: {
      id: mockUserId,
      name: 'Dr. Jane Doe',
      email: 'jane@flux.app',
      avatar: null,
    },
    childPages: [],
  };

  beforeEach(async () => {
    const mockRepo = {
      findProjectPages: jest.fn(),
      findProjectPageTree: jest.fn(),
      findPageAncestorChain: jest.fn(),
      findPageById: jest.fn(),
      findPageBySlug: jest.fn(),
      findPageWithVersions: jest.fn(),
      findChildPages: jest.fn(),
      createPage: jest.fn(),
      updatePage: jest.fn(),
      softDeletePage: jest.fn(),
      restorePage: jest.fn(),
      deletePage: jest.fn(),
      incrementPageView: jest.fn(),
      findProjectContext: jest.fn(),
      findProjectMember: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [CoreService, { provide: CoreRepository, useValue: mockRepo }],
    }).compile();

    service = module.get<CoreService>(CoreService);
    repo = module.get(CoreRepository);
  });

  describe('createPage', () => {
    it('should sanitize title and generate slug when creating a page', async () => {
      repo.findProjectContext.mockResolvedValue({ id: mockProjectId });
      repo.findProjectMember.mockResolvedValue({ role: 'contributor' });
      repo.createPage.mockResolvedValue({
        ...mockPage,
        title: 'Safe Paper Title',
        slug: 'safe-paper-title',
      });

      const result = await service.createPage(mockProjectId, mockUserId, {
        title: '<script>alert(1)</script> Safe Paper Title',
      });

      expect(repo.createPage).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Safe Paper Title',
          slug: 'safe-paper-title',
        }),
      );
      expect(result.page?.title).toBe('Safe Paper Title');
    });

    it('should reject creating a page if user has no coordinator/contributor/owner role (e.g. reviewer)', async () => {
      repo.findProjectContext.mockResolvedValue({
        id: mockProjectId,
        createdById: 'other-user',
      } as any);
      repo.findProjectMember.mockResolvedValue({ role: 'reviewer' });

      await expect(
        service.createPage(mockProjectId, mockUserId, {
          title: 'Unauthorized Doc',
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should allow creating a page if user has coordinator role', async () => {
      repo.findProjectContext.mockResolvedValue({
        id: mockProjectId,
        createdById: 'other-user',
      } as any);
      repo.findProjectMember.mockResolvedValue({ role: 'coordinator' });
      repo.createPage.mockResolvedValue({
        ...mockPage,
        id: 'page-coord-uuid',
        title: 'Coordinator Spec',
        projectId: mockProjectId,
      });

      const result = await service.createPage(mockProjectId, mockUserId, {
        title: 'Coordinator Spec',
      });
      expect(result.page?.title).toBe('Coordinator Spec');
    });

    it('should reject parent page from a different project', async () => {
      repo.findProjectContext.mockResolvedValue({ id: mockProjectId });
      repo.findProjectMember.mockResolvedValue({ role: 'owner' });
      repo.findPageById.mockResolvedValue({
        ...mockPage,
        id: 'different-parent',
        projectId: 'foreign-project-id',
      });

      await expect(
        service.createPage(mockProjectId, mockUserId, {
          title: 'Child Page',
          parentPageId: 'different-parent',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('updatePage', () => {
    it('should block content and title edits when document is locked', async () => {
      repo.findPageById.mockResolvedValue({
        ...mockPage,
        isLocked: true,
      });

      await expect(
        service.updatePage(mockPageId, {
          content: 'Malicious overwrite of locked doc',
        }),
      ).rejects.toThrow(ForbiddenException);

      await expect(
        service.updatePage(mockPageId, {
          title: 'New Title on Locked Doc',
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should allow unlocking a document when isLocked is explicitly set to false', async () => {
      repo.findPageById.mockResolvedValue({
        ...mockPage,
        isLocked: true,
      });
      repo.updatePage.mockResolvedValue({
        ...mockPage,
        isLocked: false,
      });

      const result = await service.updatePage(mockPageId, {
        isLocked: false,
      });

      expect(repo.updatePage).toHaveBeenCalledWith(
        mockPageId,
        expect.objectContaining({ isLocked: false }),
      );
      expect(result.page?.isLocked).toBe(false);
    });

    it('should sanitize title and update slug when updating page title', async () => {
      repo.findPageById.mockResolvedValue(mockPage);
      repo.updatePage.mockResolvedValue({
        ...mockPage,
        title: 'Cleaned Title',
        slug: 'cleaned-title',
      });

      await service.updatePage(mockPageId, {
        title: '  <b>Cleaned Title</b>  ',
      });

      expect(repo.updatePage).toHaveBeenCalledWith(
        mockPageId,
        expect.objectContaining({
          title: 'Cleaned Title',
          slug: 'cleaned-title',
        }),
      );
    });

    it('should prevent circular parent page hierarchy', async () => {
      repo.findPageById.mockResolvedValue(mockPage);
      const targetParentId = '44444444-4444-4444-4444-444444444444';
      repo.findPageById.mockImplementation((id: string) => {
        if (id === targetParentId) {
          return Promise.resolve({
            ...mockPage,
            id: targetParentId,
            parentPageId: mockPageId,
          });
        }
        return Promise.resolve(mockPage);
      });
      repo.findPageAncestorChain.mockResolvedValue([
        { id: targetParentId, parentPageId: mockPageId },
        { id: mockPageId, parentPageId: null },
      ]);

      await expect(
        service.updatePage(mockPageId, {
          parentPageId: targetParentId,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('createPageFile', () => {
    it('should reject creating child file inside a locked parent page', async () => {
      repo.findPageById.mockResolvedValue({
        ...mockPage,
        isLocked: true,
      });

      await expect(
        service.createPageFile(mockPageId, mockUserId, {
          title: 'section1.tex',
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should sanitize title and create child file when parent is unlocked', async () => {
      repo.findPageById.mockResolvedValue(mockPage);
      repo.createPage.mockResolvedValue({
        ...mockPage,
        id: 'child-file-id',
        title: 'methods.tex',
        parentPageId: mockPageId,
      });

      const result = await service.createPageFile(mockPageId, mockUserId, {
        title: 'methods.tex',
        content: '\\section{Methods}',
      });

      expect(repo.createPage).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'methods.tex',
          slug: 'methodstex',
          parentPage: { connect: { id: mockPageId } },
        }),
      );
      expect(result.file?.id).toBe('child-file-id');
    });
  });

  describe('deletePage and restorePage', () => {
    it('should soft-delete page and return confirmation', async () => {
      repo.findPageById.mockResolvedValue(mockPage);
      repo.softDeletePage.mockResolvedValue({
        ...mockPage,
        deletedAt: new Date(),
      });

      const result = await service.deletePage(mockPageId);
      expect(repo.softDeletePage).toHaveBeenCalledWith(mockPageId);
      expect(result.message).toBe('Page deleted successfully');
    });

    it('should restore page and return formatted page', async () => {
      repo.findPageById.mockResolvedValue({
        ...mockPage,
        deletedAt: new Date(),
      });
      repo.restorePage.mockResolvedValue({
        ...mockPage,
        deletedAt: null,
      });

      const result = await service.restorePage(mockPageId);
      expect(repo.restorePage).toHaveBeenCalledWith(mockPageId);
      expect(result.page?.deletedAt).toBeNull();
    });
  });
});
