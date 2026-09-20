import { Test, TestingModule } from '@nestjs/testing';
import { HistoryService } from '@/modules/document/history/history.service';
import { HistoryRepository } from '@/modules/document/history/history.repository';
import { PageService } from '@/modules/document/page/page.service';
import { RedisCacheService } from '@/core/cache/redis.service';
import { YjsDocumentManager } from '@/modules/document/collaboration/yjs-document.manager';
import { CollaborationGateway } from '@/modules/document/collaboration/collaboration.gateway';
import { NotFoundException } from '@nestjs/common';

describe('Document HistoryService (Snapshots, Visual Diff & Realtime Collaborative Restore)', () => {
  let service: HistoryService;
  let repo: any;
  let pageService: any;
  let cache: any;
  let yjsManager: any;
  let collaborationGateway: any;

  const mockPageId = '11111111-1111-1111-1111-111111111111';
  const mockUserId = '99999999-9999-9999-9999-999999999999';
  const mockV1Id = '22222222-2222-2222-2222-222222222222';
  const mockV2Id = '33333333-3333-3333-3333-333333333333';
  const mockUpdateBinary = new Uint8Array([1, 2, 3, 4]);

  beforeEach(async () => {
    repo = {
      findPageVersions: jest.fn(),
      findVersionById: jest.fn(),
      createVersion: jest.fn(),
      updateVersion: jest.fn(),
      deleteVersion: jest.fn(),
    };

    pageService = {
      findPageById: jest.fn(),
      updatePage: jest.fn(),
    };

    cache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
      wrap: jest.fn((key, cb) => cb()),
    };

    yjsManager = {
      replaceText: jest.fn().mockResolvedValue(mockUpdateBinary),
      getText: jest.fn().mockReturnValue('Live Yjs Draft Text\nLine 2'),
    };

    collaborationGateway = {
      broadcastYjsUpdate: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HistoryService,
        { provide: HistoryRepository, useValue: repo },
        { provide: PageService, useValue: pageService },
        { provide: RedisCacheService, useValue: cache },
        { provide: YjsDocumentManager, useValue: yjsManager },
        { provide: CollaborationGateway, useValue: collaborationGateway },
      ],
    }).compile();

    service = module.get<HistoryService>(HistoryService);
  });

  describe('getVersions', () => {
    it('should query paginated versions and return versions list with metadata', async () => {
      const mockResult = {
        versions: [
          {
            id: mockV1Id,
            pageId: mockPageId,
            title: 'Doc',
            label: 'Milestone 1',
            savedBy: { id: mockUserId, name: 'Researcher' },
          },
        ],
        total: 1,
        nextCursor: null,
      };
      repo.findPageVersions.mockResolvedValueOnce(mockResult);

      const res = await service.getVersions(mockPageId, { limit: 10 });

      expect(repo.findPageVersions).toHaveBeenCalledWith(mockPageId, {
        limit: 10,
      });
      expect(res.versions.length).toBe(1);
      expect(res.total).toBe(1);
    });
  });

  describe('updateVersion', () => {
    it('should update version label or title and invalidate cache', async () => {
      repo.findVersionById.mockResolvedValueOnce({
        id: mockV1Id,
        pageId: mockPageId,
        label: 'Old Label',
      });
      repo.updateVersion.mockResolvedValueOnce({
        id: mockV1Id,
        pageId: mockPageId,
        label: 'Camera-Ready v1',
      });

      const res = await service.updateVersion(mockPageId, mockV1Id, {
        label: 'Camera-Ready v1',
      });

      expect(repo.updateVersion).toHaveBeenCalledWith(mockV1Id, {
        label: 'Camera-Ready v1',
      });
      expect(cache.del).toHaveBeenCalled();
      expect(res.version.label).toBe('Camera-Ready v1');
    });

    it('should throw NotFoundException if version does not exist or mismatch pageId', async () => {
      repo.findVersionById.mockResolvedValueOnce(null);

      await expect(
        service.updateVersion(mockPageId, mockV1Id, { label: 'New' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('compareVersions', () => {
    it('should throw NotFoundException if a version does not exist', async () => {
      repo.findVersionById.mockResolvedValueOnce(null);

      await expect(
        service.compareVersions(mockPageId, mockV1Id, mockV2Id),
      ).rejects.toThrow(NotFoundException);
    });

    it('should compute line-by-line diff between two saved snapshot versions', async () => {
      repo.findVersionById
        .mockResolvedValueOnce({
          id: mockV1Id,
          pageId: mockPageId,
          content: 'Line 1\nLine 2 Old\nLine 3',
          label: 'v1.0',
          createdAt: new Date(),
        })
        .mockResolvedValueOnce({
          id: mockV2Id,
          pageId: mockPageId,
          content: 'Line 1\nLine 2 New\nLine 3\nLine 4 Added',
          label: 'v2.0',
          createdAt: new Date(),
        });

      const diff = await service.compareVersions(
        mockPageId,
        mockV1Id,
        mockV2Id,
      );

      expect(diff.fromVersionId).toBe(mockV1Id);
      expect(diff.toVersionId).toBe(mockV2Id);
      expect(diff.fromContent).toBe('Line 1\nLine 2 Old\nLine 3');
      expect(diff.toContent).toBe('Line 1\nLine 2 New\nLine 3\nLine 4 Added');
      expect(diff.chunks.length).toBeGreaterThan(0);

      const hasAdded = diff.chunks.some((c) => c.type === 'added');
      const hasDeleted = diff.chunks.some((c) => c.type === 'deleted');
      const hasUnchanged = diff.chunks.some((c) => c.type === 'unchanged');

      expect(hasAdded).toBe(true);
      expect(hasDeleted).toBe(true);
      expect(hasUnchanged).toBe(true);
      expect(diff.stats.addedLines).toBeGreaterThan(0);
      expect(diff.stats.deletedLines).toBeGreaterThan(0);
    });

    it('should support comparing a snapshot against current live draft (to=current)', async () => {
      repo.findVersionById.mockResolvedValueOnce({
        id: mockV1Id,
        pageId: mockPageId,
        content: 'Line 1\nLine 2 Old',
        label: 'v1.0',
        createdAt: new Date(),
      });

      // yjsManager returns 'Live Yjs Draft Text\nLine 2'
      const diff = await service.compareVersions(
        mockPageId,
        mockV1Id,
        'current',
      );

      expect(diff.fromVersionId).toBe(mockV1Id);
      expect(diff.toVersionId).toBe('current');
      expect(diff.toLabel).toBe('Current Draft');
      expect(diff.toContent).toBe('Live Yjs Draft Text\nLine 2');
      expect(diff.chunks.length).toBeGreaterThan(0);
    });
  });

  describe('restoreVersion (Collaborative)', () => {
    it('should inject replacement transaction into Yjs, broadcast update to room, and persist snapshot', async () => {
      repo.findVersionById.mockResolvedValueOnce({
        id: mockV1Id,
        pageId: mockPageId,
        content: 'Restored content for manuscript',
        title: 'Restored Title',
        label: 'Milestone Alpha',
      });

      pageService.updatePage.mockResolvedValueOnce({
        page: {
          id: mockPageId,
          title: 'Restored Title',
          content: 'Restored content for manuscript',
        },
      });

      const res = await service.restoreVersion(
        mockPageId,
        mockV1Id,
        mockUserId,
      );

      // 1. In-memory Y.Doc replacement
      expect(yjsManager.replaceText).toHaveBeenCalledWith(
        mockPageId,
        'Restored content for manuscript',
        mockUserId,
      );

      // 2. Broadcast to room via Gateway
      expect(collaborationGateway.broadcastYjsUpdate).toHaveBeenCalledWith(
        mockPageId,
        mockUpdateBinary,
      );

      // 3. Persistent write to database
      expect(pageService.updatePage).toHaveBeenCalledWith(mockPageId, {
        content: 'Restored content for manuscript',
        title: 'Restored Title',
      });

      // 4. Record new restore milestone snapshot in append-only history
      expect(repo.createVersion).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'Restored content for manuscript',
          label: 'Restored to "Milestone Alpha"',
          savedById: mockUserId,
        }),
      );

      expect(res.message).toBe('Version restored successfully');
    });
  });
});
