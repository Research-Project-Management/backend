import { Test, TestingModule } from '@nestjs/testing';
import { HistoryService } from '@/modules/document/history/history.service';
import { HistoryRepository } from '@/modules/document/history/history.repository';
import { PageService } from '@/modules/document/core/core.service';
import { RedisCacheService } from '@/core/cache/redis.service';
import { NotFoundException } from '@nestjs/common';

describe('Document HistoryService (Snapshots & Visual Diff)', () => {
  let service: HistoryService;
  let repo: any;
  let pageService: any;
  let cache: any;

  const mockPageId = '11111111-1111-1111-1111-111111111111';
  const mockV1Id = '22222222-2222-2222-2222-222222222222';
  const mockV2Id = '33333333-3333-3333-3333-333333333333';

  beforeEach(async () => {
    repo = {
      findPageVersions: jest.fn(),
      findVersionById: jest.fn(),
      createVersion: jest.fn(),
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
      wrap: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HistoryService,
        { provide: HistoryRepository, useValue: repo },
        { provide: PageService, useValue: pageService },
        { provide: RedisCacheService, useValue: cache },
      ],
    }).compile();

    service = module.get<HistoryService>(HistoryService);
  });

  describe('compareVersions', () => {
    it('should throw NotFoundException if a version does not exist', async () => {
      repo.findVersionById.mockResolvedValueOnce(null);

      await expect(
        service.compareVersions(mockPageId, mockV1Id, mockV2Id),
      ).rejects.toThrow(NotFoundException);
    });

    it('should compute line-by-line diff with added, deleted, and unchanged chunks', async () => {
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
  });

  describe('restoreVersion', () => {
    it('should restore page content to version snapshot state', async () => {
      repo.findVersionById.mockResolvedValueOnce({
        id: mockV1Id,
        pageId: mockPageId,
        content: 'Restored content',
        title: 'Restored Title',
      });

      pageService.updatePage.mockResolvedValueOnce({
        page: { id: mockPageId, title: 'Restored Title' },
      });

      const res = await service.restoreVersion(mockPageId, mockV1Id);

      expect(pageService.updatePage).toHaveBeenCalledWith(mockPageId, {
        content: 'Restored content',
        title: 'Restored Title',
      });
      expect(res.message).toBe('Version restored successfully');
    });
  });
});
