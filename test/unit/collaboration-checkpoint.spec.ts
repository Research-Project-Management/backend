import { YjsDocumentManager } from '@/modules/document/collaboration/yjs-document.manager';
import { CollaborationQueueConsumer } from '@/modules/document/collaboration/collaboration-queue.consumer';
import { PageRepository } from '@/modules/document/page/page.repository';
import {
  DOCUMENT_COLLABORATIVE_CHECKPOINT_JOB,
  QueuedCheckpointJob,
} from '@/modules/document/collaboration/constants/collaboration-queue.constants';
import { VersionEventType } from '@prisma/client';
import { Job } from 'bullmq';
import * as Y from 'yjs';

describe('Collaboration Checkpointing & BullMQ Pipeline', () => {
  const mockPageId = '44444444-4444-4444-4444-444444444444';
  const mockUserId = 'user-test-789';

  describe('YjsDocumentManager Checkpointing', () => {
    let manager: YjsDocumentManager;
    let mockPageRepo: jest.Mocked<Partial<PageRepository>>;
    let mockPrisma: any;
    let mockQueue: any;

    beforeEach(() => {
      mockPageRepo = {
        findPageById: jest.fn().mockResolvedValue({
          id: mockPageId,
          content: 'Hello Overleaf Checkpoint',
        } as any),
        updatePage: jest.fn().mockResolvedValue({} as any),
      };

      mockPrisma = {
        pageVersion: {
          create: jest.fn().mockResolvedValue({ id: 'v-cp-1' }),
        },
      };

      mockQueue = {
        add: jest.fn().mockResolvedValue({ id: 'job-1' }),
      };

      manager = new YjsDocumentManager(
        mockPageRepo as PageRepository,
        mockPrisma,
        undefined, // redis
        mockQueue,
      );
    });

    afterEach(async () => {
      await manager.onModuleDestroy();
    });

    it('should dispatch checkpoint job to BullMQ queue when available', async () => {
      await manager.getOrCreateDoc(mockPageId);

      await manager.createCollaborativeCheckpoint(
        mockPageId,
        mockUserId,
        'Milestone Alpha',
        25,
      );

      expect(mockQueue.add).toHaveBeenCalledTimes(1);
      expect(mockQueue.add).toHaveBeenCalledWith(
        DOCUMENT_COLLABORATIVE_CHECKPOINT_JOB,
        expect.objectContaining({
          pageId: mockPageId,
          content: 'Hello Overleaf Checkpoint',
          savedById: mockUserId,
          label: 'Milestone Alpha',
          editsCount: 25,
        }),
        expect.objectContaining({
          attempts: 3,
        }),
      );
      // Prisma shouldn't be called directly when queue succeeds
      expect(mockPrisma.pageVersion.create).not.toHaveBeenCalled();
    });

    it('should fall back to direct Prisma write when BullMQ queue fails', async () => {
      mockQueue.add.mockRejectedValueOnce(new Error('Redis connection lost'));
      await manager.getOrCreateDoc(mockPageId);

      await manager.createCollaborativeCheckpoint(
        mockPageId,
        mockUserId,
        'Fallback Checkpoint',
      );

      expect(mockPrisma.pageVersion.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            pageId: mockPageId,
            savedById: mockUserId,
            eventType: VersionEventType.collaborative_checkpoint,
            label: 'Fallback Checkpoint',
          }),
        }),
      );
    });

    it('should automatically trigger checkpoint when edit threshold (50) is reached', async () => {
      await manager.getOrCreateDoc(mockPageId);

      const clientDoc = new Y.Doc();
      const clientText = clientDoc.getText('monaco');

      // Apply 50 individual character updates
      for (let i = 0; i < 50; i++) {
        clientText.insert(0, `a`);
        const update = Y.encodeStateAsUpdate(clientDoc);
        manager.applyUpdate(mockPageId, update, mockUserId);
      }

      // Verify that triggerAutoCheckpoint resulted in a job queued with 50 edits count
      expect(mockQueue.add).toHaveBeenCalledWith(
        DOCUMENT_COLLABORATIVE_CHECKPOINT_JOB,
        expect.objectContaining({
          pageId: mockPageId,
          savedById: mockUserId,
          label: expect.stringContaining('50 edits'),
          editsCount: 50,
        }),
        expect.any(Object),
      );

      clientDoc.destroy();
    });
  });

  describe('CollaborationQueueConsumer (BullMQ Worker)', () => {
    let consumer: CollaborationQueueConsumer;
    let mockPrisma: any;
    let mockRedis: any;

    beforeEach(() => {
      mockPrisma = {
        pageVersion: {
          create: jest.fn().mockResolvedValue({ id: 'v-saved-100' }),
        },
      };

      mockRedis = {
        del: jest.fn().mockResolvedValue(1),
        zremrangebyscore: jest.fn().mockResolvedValue(1),
      };

      consumer = new CollaborationQueueConsumer(mockPrisma, mockRedis);
    });

    it('should process checkpoint job and persist to Prisma pageVersion', async () => {
      const mockJob = {
        name: DOCUMENT_COLLABORATIVE_CHECKPOINT_JOB,
        data: {
          pageId: mockPageId,
          content: 'Persisted LaTeX Document',
          savedById: mockUserId,
          label: 'Pre-flight check',
          editsCount: 15,
        },
      } as Job<QueuedCheckpointJob>;

      await consumer.process(mockJob);

      expect(mockPrisma.pageVersion.create).toHaveBeenCalledWith({
        data: {
          pageId: mockPageId,
          content: 'Persisted LaTeX Document',
          savedById: mockUserId,
          eventType: VersionEventType.collaborative_checkpoint,
          label: 'Pre-flight check',
        },
      });

      // Should invalidate version history cache
      expect(mockRedis.del).toHaveBeenCalledWith(
        expect.stringContaining(mockPageId),
      );
    });

    it('should ignore unrecognized jobs without throwing', async () => {
      const mockJob = {
        name: 'unrelated-email-job',
        data: {} as any,
      } as Job<QueuedCheckpointJob>;

      await expect(consumer.process(mockJob)).resolves.toBeUndefined();
      expect(mockPrisma.pageVersion.create).not.toHaveBeenCalled();
    });

    it('should rethrow error to let BullMQ handle retry when Prisma fails', async () => {
      mockPrisma.pageVersion.create.mockRejectedValueOnce(
        new Error('PostgreSQL connection timeout'),
      );

      const mockJob = {
        name: DOCUMENT_COLLABORATIVE_CHECKPOINT_JOB,
        data: {
          pageId: mockPageId,
          content: 'Failed doc',
        },
      } as Job<QueuedCheckpointJob>;

      await expect(consumer.process(mockJob)).rejects.toThrow(
        'PostgreSQL connection timeout',
      );
    });
  });
});
