import { Test, TestingModule } from '@nestjs/testing';
import { HistoryOpLogService } from '@/modules/document/history/history-oplog.service';
import { PageService } from '@/modules/document/page/page.service';
import { RedisCacheService } from '@/core/cache/redis.service';
import { PrismaService } from '@/core/database/prisma.service';
import { NotFoundException } from '@nestjs/common';
import * as Y from 'yjs';

describe('HistoryOpLogService (Multi-tiered Hot Oplog + Cold Snapshot Replay & Compaction)', () => {
  let service: HistoryOpLogService;
  let pageService: jest.Mocked<PageService>;
  let redis: jest.Mocked<RedisCacheService>;
  let prisma: any;

  const mockPageId = '11111111-1111-1111-1111-111111111111';

  beforeEach(async () => {
    pageService = {
      findPageById: jest.fn(),
    } as any;

    redis = {
      isReady: jest.fn().mockReturnValue(true),
      zrangebyscore: jest.fn().mockResolvedValue([]),
      zremrangebyscore: jest.fn().mockResolvedValue(0),
    } as any;

    prisma = {
      pageVersion: {
        findFirst: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HistoryOpLogService,
        { provide: PageService, useValue: pageService },
        { provide: RedisCacheService, useValue: redis },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<HistoryOpLogService>(HistoryOpLogService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('getTimeline', () => {
    it('should return chronological entries and timeline metadata from Redis oplog', async () => {
      redis.zrangebyscore.mockResolvedValueOnce([
        { member: 'AQIDBA==', score: 1000 },
        { member: 'BQYHCA==', score: 2000 },
      ]);

      const timeline = await service.getTimeline(mockPageId, 500, 2500);

      expect(timeline.pageId).toBe(mockPageId);
      expect(timeline.totalOps).toBe(2);
      expect(timeline.oldestMs).toBe(1000);
      expect(timeline.newestMs).toBe(2000);
      expect(timeline.entries).toHaveLength(2);
      expect(timeline.entries[0].timestamp).toBe(1000);
      expect(redis.zrangebyscore).toHaveBeenCalledWith(
        `flux:collab:oplog:${mockPageId}`,
        500,
        2500,
      );
    });

    it('should return empty timeline gracefully when Redis is not ready', async () => {
      redis.isReady.mockReturnValue(false);

      const timeline = await service.getTimeline(mockPageId);
      expect(timeline.totalOps).toBe(0);
      expect(timeline.entries).toEqual([]);
      expect(timeline.oldestMs).toBeNull();
    });
  });

  describe('replayToPoint (Multi-tiered Retrieval)', () => {
    it('should throw NotFoundException if page does not exist', async () => {
      pageService.findPageById.mockResolvedValueOnce(null);

      await expect(service.replayToPoint(mockPageId, 1000)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should replay from hot Redis binary oplog preserving causal Yjs updates', async () => {
      const targetTime = 8000;

      pageService.findPageById.mockResolvedValueOnce({
        id: mockPageId,
        content: 'Latest content',
      } as any);

      // Create two real Yjs updates in sequence on the same doc
      const doc = new Y.Doc();
      const yText = doc.getText('monaco');
      const updates: Uint8Array[] = [];
      doc.on('update', (u: Uint8Array) => {
        updates.push(u);
      });

      yText.insert(0, 'Hello');
      yText.insert(5, ' World');

      const op1Base64 = Buffer.from(updates[0]).toString('base64');
      const op2Base64 = Buffer.from(updates[1]).toString('base64');

      // Redis returns both hot ops up to targetTime
      redis.zrangebyscore.mockResolvedValueOnce([
        { member: op1Base64, score: 6000 },
        { member: op2Base64, score: 7000 },
      ]);

      const result = await service.replayToPoint(mockPageId, targetTime);

      expect(redis.zrangebyscore).toHaveBeenCalledWith(
        `flux:collab:oplog:${mockPageId}`,
        '-inf',
        targetTime,
      );
      expect(result).toBe('Hello World');
      doc.destroy();
    });

    it('should fall back to closest cold storage PageVersion snapshot when Redis has no hot ops', async () => {
      const targetTime = 5000;

      pageService.findPageById.mockResolvedValueOnce({
        id: mockPageId,
        content: 'Latest page content',
      } as any);

      // Redis has no hot ops (they were compacted/pruned)
      redis.zrangebyscore.mockResolvedValueOnce([]);

      // Cold storage returns historical PageVersion
      prisma.pageVersion.findFirst.mockResolvedValueOnce({
        id: 'snapshot-v1',
        content: 'Historical Cold Snapshot Content',
        createdAt: new Date(4000),
      });

      const result = await service.replayToPoint(mockPageId, targetTime);

      expect(prisma.pageVersion.findFirst).toHaveBeenCalledWith({
        where: {
          pageId: mockPageId,
          createdAt: { lte: new Date(targetTime) },
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true, content: true, createdAt: true },
      });

      expect(result).toBe('Historical Cold Snapshot Content');
    });

    it('should fall back to current page content when no hot ops and no prior snapshots exist', async () => {
      pageService.findPageById.mockResolvedValueOnce({
        id: mockPageId,
        content: 'Base fallback content',
      } as any);

      redis.zrangebyscore.mockResolvedValueOnce([]);
      prisma.pageVersion.findFirst.mockResolvedValueOnce(null);

      const result = await service.replayToPoint(mockPageId, 2000);
      expect(result).toBe('Base fallback content');
    });

    it('should return cold snapshot or base content safely when Redis is not ready', async () => {
      redis.isReady.mockReturnValue(false);

      pageService.findPageById.mockResolvedValueOnce({
        id: mockPageId,
        content: 'Fallback page content',
      } as any);

      prisma.pageVersion.findFirst.mockResolvedValueOnce({
        id: 'snap-1',
        content: 'Cold snapshot when Redis offline',
        createdAt: new Date(1000),
      });

      const result = await service.replayToPoint(mockPageId, 2000);
      expect(result).toBe('Cold snapshot when Redis offline');
    });
  });

  describe('compactOpLog', () => {
    it('should remove operations up to olderThanMs and return count', async () => {
      redis.zremrangebyscore.mockResolvedValueOnce(25);

      const removed = await service.compactOpLog(mockPageId, 5000);

      expect(redis.zremrangebyscore).toHaveBeenCalledWith(
        `flux:collab:oplog:${mockPageId}`,
        '-inf',
        5000,
      );
      expect(removed).toBe(25);
    });

    it('should return 0 when Redis is not ready', async () => {
      redis.isReady.mockReturnValue(false);

      const removed = await service.compactOpLog(mockPageId, 5000);
      expect(removed).toBe(0);
      expect(redis.zremrangebyscore).not.toHaveBeenCalled();
    });
  });
});