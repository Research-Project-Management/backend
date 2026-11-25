import {
  CitationIndexService,
  CitationMetricsService,
} from '@/modules/pages/citations/services/index.service';
import { CitationSyncQueueService } from '@/modules/pages/citations/services/sync.service';
import { BibtexParser } from '@/modules/pages/citations/domain/bibtex.domain';
import {
  BibEntry,
  BibliographyFile,
} from '@/modules/pages/citations/domain/bib-entry.domain';
import type { CitationsRepository } from '@/modules/pages/citations/repositories/citations.repository';
import type { RedisCacheService } from '@/core';
import type { Queue } from 'bullmq';

describe('Pages Citations - Sprint 3 CQRS Index & Async Sync Queue', () => {
  describe('CitationIndexService (L1 LRU + L2 Redis + Event Invalidation)', () => {
    it('serves repeated reads from L1/L2 cache without calling collectBibFiles again', async () => {
      const store = new Map<string, unknown>();
      const mockRedis = {
        get: jest.fn(async (k: string) => store.get(k) ?? null),
        set: jest.fn(async (k: string, v: unknown) => {
          store.set(k, v);
        }),
        del: jest.fn(async (k: string) => {
          store.delete(k);
        }),
      } as unknown as RedisCacheService;

      const mockRepo = {
        collectBibFiles: jest.fn(async () => [
          new BibliographyFile({
            path: '/references.bib',
            entries: [
              new BibEntry({
                key: 'vaswani2017',
                entryType: 'inproceedings',
                fields: {
                  title: 'Attention Is All You Need',
                  author: 'Vaswani, Ashish',
                  year: '2017',
                },
              }),
            ],
          }),
        ]),
      } as unknown as CitationsRepository;

      const indexSvc = new CitationIndexService(mockRepo, mockRedis);

      // First call warms L1 + L2
      const r1 = await indexSvc.queryCitations('space-1', 'vaswani', 50);
      expect(r1.total).toBe(1);
      expect(mockRepo.collectBibFiles).toHaveBeenCalledTimes(1);

      // Second call hits L1 without touching repository
      const r2 = await indexSvc.queryCitations('space-1', 'attention', 50);
      expect(r2.total).toBe(1);
      expect(mockRepo.collectBibFiles).toHaveBeenCalledTimes(1);

      // After invalidation, next read refreshes from repository
      await indexSvc.invalidateSpace('space-1');
      const r3 = await indexSvc.queryCitations('space-1', '', 50);
      expect(r3.total).toBe(1);
      expect(mockRepo.collectBibFiles).toHaveBeenCalledTimes(2);
    });
  });

  describe('CitationSyncQueueService (BullMQ Async Sync)', () => {
    it('enqueues sync job and returns job status', async () => {
      const mockQueue = {
        add: jest.fn(async () => ({ id: 'job-123' })),
        getJob: jest.fn(async (id: string) =>
          id === 'job-123'
            ? {
                id: 'job-123',
                progress: 100,
                returnvalue: {
                  filePath: '/references.bib',
                  entries: [],
                  conflicts: [],
                },
                getState: async () => 'completed',
              }
            : null,
        ),
      } as unknown as Queue;

      const queueSvc = new CitationSyncQueueService(mockQueue);
      expect(queueSvc.isAvailable()).toBe(true);

      const enqueued = await queueSvc.enqueueSync({
        spaceId: 'space-1',
        userId: 'user-1',
        dto: { collectionId: 'zotero:abc' },
      });
      expect(enqueued).toEqual({ jobId: 'job-123', status: 'queued' });

      const status = await queueSvc.getJobStatus('job-123');
      expect(status.state).toBe('completed');
      expect(status.progress).toBe(100);
      expect(status.result?.filePath).toBe('/references.bib');
    });
  });

  describe('ConflictPolicy Strategy (skip & rename) & CitationMetricsService', () => {
    const parser = new BibtexParser();

    it('supports skip and rename conflict policies in upsertEntriesBatch', () => {
      const existing = '@article{vaswani2017,\n  title = {Original},\n}';
      const incoming = [
        {
          key: 'vaswani2017',
          bibString: '@article{vaswani2017,\n  title = {New Version},\n}',
        },
      ];

      // skip policy preserves original untouched
      const skipped = BibtexParser.upsertEntriesBatch(existing, incoming, 'skip');
      expect(skipped.conflicts).toEqual(['vaswani2017']);
      expect(parser.parse(skipped.text)[0].title).toBe('Original');

      // rename policy keeps original and appends vaswani2017_2
      const renamed = BibtexParser.upsertEntriesBatch(existing, incoming, 'rename');
      expect(renamed.conflicts).toEqual(['vaswani2017']);
      expect(renamed.renamedKeys).toEqual({ vaswani2017: 'vaswani2017_2' });
      const parsed = parser.parse(renamed.text);
      expect(parsed.map((e) => e.key.value)).toEqual([
        'vaswani2017',
        'vaswani2017_2',
      ]);
    });

    it('records index cache hits and OCC retries in CitationMetricsService', () => {
      const metrics = new CitationMetricsService();
      metrics.recordIndexHit('l1');
      metrics.recordIndexHit('l2');
      metrics.recordIndexHit('l3');
      metrics.recordOccRetry();
      metrics.recordConflicts(2);

      const snap = metrics.getSnapshot();
      expect(snap.indexReads).toEqual({
        l1Hits: 1,
        l2Hits: 1,
        l3Hits: 1,
        coldFallbacks: 0,
      });
      expect(snap.writes).toEqual({ occRetries: 1, conflictsDetected: 2 });
    });
  });
});
