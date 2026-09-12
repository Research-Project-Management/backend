import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PageService } from '@/modules/document/page/page.service';
import { PageRepository } from '@/modules/document/page/page.repository';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PageStatus } from '@prisma/client';

describe('Document Module — PageService Unit Tests', () => {
  let service: PageService;
  let mockPageRepo: any;
  let mockEventEmitter: any;

  const mockProjectId = 'proj-123';
  const mockUserId = 'user-creator-1';
  const mockMemberUserId = 'user-member-2';
  const mockStrangerUserId = 'user-stranger-3';
  const mockPageId = 'page-123';

  beforeEach(() => {
    mockPageRepo = {
      findProjectContext: jest.fn(),
      findProjectMember: jest.fn(),
      findProjectPages: jest.fn(),
      findProjectPageTree: jest.fn(),
      findPageById: jest.fn(),
      findPageAncestorChain: jest.fn(),
      createPage: jest.fn(),
      updatePage: jest.fn(),
      softDeletePage: jest.fn(),
      restorePage: jest.fn(),
      deletePage: jest.fn(),
      incrementPageView: jest.fn(),
      findChildPages: jest.fn(),
    };

    mockEventEmitter = {
      emit: jest.fn(),
    };

    service = new PageService(
      mockPageRepo as unknown as PageRepository,
      mockEventEmitter as unknown as EventEmitter2,
    );
  });

  describe('createPage — Project Scoped Authorization', () => {
    it('allows project creator to create a page', async () => {
      mockPageRepo.findProjectContext!.mockResolvedValue({
        id: mockProjectId,
        workspaceId: 'ws-123',
        createdById: mockUserId,
      } as any);
      mockPageRepo.findProjectMember!.mockResolvedValue(null);
      mockPageRepo.createPage!.mockResolvedValue({
        id: 'new-page-1',
        title: 'Introduction',
        slug: 'introduction',
        status: PageStatus.draft,
        workspaceId: 'ws-123',
        projectId: mockProjectId,
        authorId: mockUserId,
        parentPageId: null,
        mainFileId: null,
      } as any);

      const result = await service.createPage(mockProjectId, mockUserId, {
        title: 'Introduction',
      });

      expect(result.page?.id).toBe('new-page-1');
      expect(result.page?.title).toBe('Introduction');
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'page.created',
        expect.anything(),
      );
    });

    it('allows project contributor member to create a page', async () => {
      mockPageRepo.findProjectContext!.mockResolvedValue({
        id: mockProjectId,
        workspaceId: 'ws-123',
        createdById: mockUserId,
      } as any);
      mockPageRepo.findProjectMember!.mockResolvedValue({
        role: 'contributor',
      });
      mockPageRepo.createPage!.mockResolvedValue({
        id: 'new-page-2',
        title: 'Related Work',
        slug: 'related-work',
        status: PageStatus.draft,
        workspaceId: 'ws-123',
        projectId: mockProjectId,
        authorId: mockMemberUserId,
        parentPageId: null,
        mainFileId: null,
      } as any);

      const result = await service.createPage(
        mockProjectId,
        mockMemberUserId,
        {
          title: 'Related Work',
        },
      );

      expect(result.page?.id).toBe('new-page-2');
    });

    it('blocks stranger or viewer from creating a page', async () => {
      mockPageRepo.findProjectContext!.mockResolvedValue({
        id: mockProjectId,
        workspaceId: 'ws-123',
        createdById: mockUserId,
      } as any);
      mockPageRepo.findProjectMember!.mockResolvedValue({
        role: 'viewer',
      });

      await expect(
        service.createPage(mockProjectId, mockStrangerUserId, {
          title: 'Unauthorized Page',
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws BadRequestException when projectId is missing', async () => {
      await expect(
        service.createPage('', mockUserId, { title: 'No Project' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException when project does not exist', async () => {
      mockPageRepo.findProjectContext!.mockResolvedValue(null);

      await expect(
        service.createPage('non-existent-proj', mockUserId, {
          title: 'Orphan Page',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('validates parent page belongs to the same project', async () => {
      mockPageRepo.findProjectContext!.mockResolvedValue({
        id: mockProjectId,
        workspaceId: 'ws-123',
        createdById: mockUserId,
      } as any);
      mockPageRepo.findProjectMember!.mockResolvedValue({ role: 'owner' });
      mockPageRepo.findPageById!.mockResolvedValue({
        id: 'parent-other-proj',
        projectId: 'different-project-id',
      } as any);

      await expect(
        service.createPage(mockProjectId, mockUserId, {
          title: 'Child Page',
          parentPageId: 'parent-other-proj',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('getPage — Retrieval and Formatting', () => {
    it('returns formatted page details when page exists', async () => {
      mockPageRepo.findPageById!.mockResolvedValue({
        id: mockPageId,
        title: 'Methodology',
        projectId: mockProjectId,
        parentPageId: 'parent-1',
        mainFileId: 'file-1',
      } as any);

      const result = await service.getPage(mockPageId, mockProjectId);

      expect(result.page.id).toBe(mockPageId);
      expect(result.page.parentPage).toBe('parent-1');
      expect(result.page.mainFile).toBe('file-1');
    });

    it('throws NotFoundException when page belongs to different project', async () => {
      mockPageRepo.findPageById!.mockResolvedValue({
        id: mockPageId,
        title: 'Methodology',
        projectId: 'other-project',
      } as any);

      await expect(
        service.getPage(mockPageId, mockProjectId),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('updatePage & softDelete', () => {
    it('updates page attributes successfully', async () => {
      mockPageRepo.findPageById!.mockResolvedValue({
        id: mockPageId,
        title: 'Old Title',
        projectId: mockProjectId,
        parentPageId: null,
      } as any);
      mockPageRepo.updatePage!.mockResolvedValue({
        id: mockPageId,
        title: 'Updated Title',
        projectId: mockProjectId,
        parentPageId: null,
      } as any);

      const result = await service.updatePage(
        mockPageId,
        { title: 'Updated Title' },
        mockProjectId,
      );

      expect(result.page?.title).toBe('Updated Title');
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'page.updated',
        expect.anything(),
      );
    });

    it('soft deletes page successfully', async () => {
      mockPageRepo.findPageById!.mockResolvedValue({
        id: mockPageId,
        projectId: mockProjectId,
      } as any);
      mockPageRepo.softDeletePage!.mockResolvedValue({
        id: mockPageId,
      } as any);

      const result = await service.deletePage(mockPageId, mockProjectId);

      expect(result.message).toBe('Page deleted successfully');
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'page.deleted',
        expect.anything(),
      );
    });
  });

  describe('duplicatePage', () => {
    it('duplicates existing page with new author and (Copy) title', async () => {
      mockPageRepo.findPageById!.mockResolvedValue({
        id: mockPageId,
        title: 'Abstract',
        projectId: mockProjectId,
        workspaceId: 'ws-123',
        content: { text: 'content' },
        status: PageStatus.draft,
        parentPageId: null,
      } as any);

      mockPageRepo.createPage!.mockResolvedValue({
        id: 'dup-page-1',
        title: 'Abstract (Copy)',
        projectId: mockProjectId,
        workspaceId: 'ws-123',
        authorId: mockUserId,
        parentPageId: null,
      } as any);

      const result = await service.duplicatePage(
        mockPageId,
        mockUserId,
        mockProjectId,
      );

      expect(result.page?.id).toBe('dup-page-1');
      expect(result.page?.title).toBe('Abstract (Copy)');
    });
  });

  describe('checkUserAccess & checkProjectAccess', () => {
    it('checkUserAccess returns true for author', async () => {
      mockPageRepo.findPageById!.mockResolvedValue({
        id: mockPageId,
        authorId: mockUserId,
        projectId: mockProjectId,
      } as any);

      const allowed = await service.checkUserAccess(mockPageId, mockUserId);
      expect(allowed).toBe(true);
    });

    it('checkUserAccess returns true for project member', async () => {
      mockPageRepo.findPageById!.mockResolvedValue({
        id: mockPageId,
        authorId: 'other-author',
        projectId: mockProjectId,
      } as any);
      mockPageRepo.findProjectMember!.mockResolvedValue({ role: 'contributor' });

      const allowed = await service.checkUserAccess(
        mockPageId,
        mockMemberUserId,
      );
      expect(allowed).toBe(true);
    });

    it('checkProjectAccess returns true for creator and project member', async () => {
      mockPageRepo.findProjectContext!.mockResolvedValue({
        id: mockProjectId,
        createdById: mockUserId,
      } as any);

      const creatorAllowed = await service.checkProjectAccess(
        mockProjectId,
        mockUserId,
      );
      expect(creatorAllowed).toBe(true);

      mockPageRepo.findProjectMember!.mockResolvedValue({ role: 'viewer' });
      const memberAllowed = await service.checkProjectAccess(
        mockProjectId,
        mockMemberUserId,
      );
      expect(memberAllowed).toBe(true);
    });
  });
});
