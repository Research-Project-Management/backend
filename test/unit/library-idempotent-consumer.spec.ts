import { IdempotentConsumerService } from '../../src/modules/library/shared-kernel/outbox/services/idempotent-consumer.service';
import { ExtractionHandler } from '../../src/modules/library/reader/application/handlers/extraction.handler';
import { fromPartial } from '@total-typescript/shoehorn';
import { OutboxEvent } from '@prisma/client';

describe('IdempotentConsumerService & Inbox Pattern', () => {
  describe('In-Memory Mode (Redis unavailable or standalone)', () => {
    let service: IdempotentConsumerService;

    beforeEach(() => {
      service = new IdempotentConsumerService();
      service.clearMemoryStore();
    });

    it('should execute handler on first arrival and mark completed', async () => {
      const handlerFn = jest.fn().mockResolvedValue('success-payload');

      const result = await service.executeIdempotent({
        consumer: 'test-consumer',
        eventId: 'evt-100',
        handler: handlerFn,
      });

      expect(result.executed).toBe(true);
      expect(result.skipped).toBe(false);
      expect(result.result).toBe('success-payload');
      expect(handlerFn).toHaveBeenCalledTimes(1);

      const isDone = await service.isProcessed('test-consumer', 'evt-100');
      expect(isDone).toBe(true);
    });

    it('should skip duplicate event if already completed', async () => {
      const handlerFn = jest.fn().mockResolvedValue('success-payload');

      // 1st run
      await service.executeIdempotent({
        consumer: 'test-consumer',
        eventId: 'evt-101',
        handler: handlerFn,
      });

      // 2nd run with same eventId
      const secondRun = await service.executeIdempotent({
        consumer: 'test-consumer',
        eventId: 'evt-101',
        handler: handlerFn,
      });

      expect(secondRun.executed).toBe(false);
      expect(secondRun.skipped).toBe(true);
      expect(secondRun.reason).toBe('ALREADY_COMPLETED');
      expect(handlerFn).toHaveBeenCalledTimes(1); // Not called second time
    });

    it('should skip duplicate concurrent execution if currently in-flight', async () => {
      let resolveFirstHandler: (val: any) => void;
      const firstHandlerPromise = new Promise((resolve) => {
        resolveFirstHandler = resolve;
      });

      const longRunningHandler = jest.fn().mockReturnValue(firstHandlerPromise);
      const secondHandler = jest.fn().mockResolvedValue('second-result');

      // Start 1st run (remains in-flight)
      const firstRunPromise = service.executeIdempotent({
        consumer: 'test-consumer',
        eventId: 'evt-102',
        handler: longRunningHandler,
      });

      // Immediately attempt 2nd run while 1st is still executing
      const secondRun = await service.executeIdempotent({
        consumer: 'test-consumer',
        eventId: 'evt-102',
        handler: secondHandler,
      });

      expect(secondRun.executed).toBe(false);
      expect(secondRun.skipped).toBe(true);
      expect(secondRun.reason).toBe('IN_FLIGHT');
      expect(secondHandler).not.toHaveBeenCalled();

      // Finish first handler
      resolveFirstHandler!('done');
      const firstRun = await firstRunPromise;
      expect(firstRun.executed).toBe(true);
      expect(firstRun.result).toBe('done');
    });

    it('should release lease upon exception so subsequent retry can succeed', async () => {
      let callCount = 0;
      const failingHandler = jest.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Transient network error');
        }
        return 'retry-success';
      });

      // 1st run fails
      await expect(
        service.executeIdempotent({
          consumer: 'test-consumer',
          eventId: 'evt-103',
          handler: failingHandler,
        }),
      ).rejects.toThrow('Transient network error');

      // Verify that lease was released (not marked completed or locked)
      const isDone = await service.isProcessed('test-consumer', 'evt-103');
      expect(isDone).toBe(false);

      // 2nd run (BullMQ retry) should now acquire the lease and succeed
      const retryResult = await service.executeIdempotent({
        consumer: 'test-consumer',
        eventId: 'evt-103',
        handler: failingHandler,
      });

      expect(retryResult.executed).toBe(true);
      expect(retryResult.result).toBe('retry-success');
      expect(failingHandler).toHaveBeenCalledTimes(2);
    });

    it('should allow resetting an event key', async () => {
      const handlerFn = jest.fn().mockResolvedValue('done');

      await service.executeIdempotent({
        consumer: 'test-consumer',
        eventId: 'evt-104',
        handler: handlerFn,
      });

      expect(await service.isProcessed('test-consumer', 'evt-104')).toBe(true);

      await service.reset('test-consumer', 'evt-104');
      expect(await service.isProcessed('test-consumer', 'evt-104')).toBe(false);

      // Can execute again after reset
      const reRun = await service.executeIdempotent({
        consumer: 'test-consumer',
        eventId: 'evt-104',
        handler: handlerFn,
      });
      expect(reRun.executed).toBe(true);
      expect(handlerFn).toHaveBeenCalledTimes(2);
    });
  });

  describe('Distributed Redis Atomic Mode', () => {
    let mockClient: any;
    let mockRedisService: any;
    let service: IdempotentConsumerService;

    beforeEach(() => {
      const redisStore = new Map<string, string>();

      mockClient = {
        set: jest.fn(async (key: string, val: string, ...args: any[]) => {
          const hasNX = args.includes('NX');
          if (hasNX && redisStore.has(key)) {
            return null; // Key already exists
          }
          redisStore.set(key, val);
          return 'OK';
        }),
        get: jest.fn(async (key: string) => {
          return redisStore.get(key) || null;
        }),
        del: jest.fn(async (key: string) => {
          redisStore.delete(key);
          return 1;
        }),
      };

      mockRedisService = {
        isReady: jest.fn().mockReturnValue(true),
        getClient: jest.fn().mockReturnValue(mockClient),
      };

      service = new IdempotentConsumerService(mockRedisService);
    });

    it('should use Redis atomic SET NX EX to claim distributed lease', async () => {
      const handler = jest.fn().mockResolvedValue('redis-result');

      const res = await service.executeIdempotent({
        consumer: 'worker-a',
        eventId: 'evt-200',
        leaseTtlSeconds: 120,
        retentionTtlSeconds: 3600,
        handler,
      });

      expect(res.executed).toBe(true);
      expect(res.result).toBe('redis-result');
      // Checked atomic lease with NX
      expect(mockClient.set).toHaveBeenCalledWith(
        'library:inbox:worker-a:evt-200',
        expect.stringContaining('"status":"processing"'),
        'EX',
        120,
        'NX',
      );
      // Completed with retention TTL
      expect(mockClient.set).toHaveBeenCalledWith(
        'library:inbox:worker-a:evt-200',
        expect.stringContaining('"status":"completed"'),
        'EX',
        3600,
      );
    });

    it('should detect ALREADY_COMPLETED from Redis when SET NX fails', async () => {
      const handler = jest.fn().mockResolvedValue('initial');

      // First run succeeds
      await service.executeIdempotent({
        consumer: 'worker-b',
        eventId: 'evt-201',
        handler,
      });

      // Second run detects completed status
      const secondRes = await service.executeIdempotent({
        consumer: 'worker-b',
        eventId: 'evt-201',
        handler,
      });

      expect(secondRes.executed).toBe(false);
      expect(secondRes.skipped).toBe(true);
      expect(secondRes.reason).toBe('ALREADY_COMPLETED');
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should detect IN_FLIGHT when SET NX fails and existing status is processing', async () => {
      // Simulate another worker having set status to processing
      mockClient.set(
        'library:inbox:worker-c:evt-202',
        JSON.stringify({ status: 'processing', startedAt: Date.now() }),
      );

      const handler = jest.fn();
      const res = await service.executeIdempotent({
        consumer: 'worker-c',
        eventId: 'evt-202',
        handler,
      });

      expect(res.executed).toBe(false);
      expect(res.skipped).toBe(true);
      expect(res.reason).toBe('IN_FLIGHT');
      expect(handler).not.toHaveBeenCalled();
    });

    it('should delete Redis key upon failure to release distributed lease', async () => {
      const failingHandler = jest.fn().mockRejectedValue(new Error('S3 error'));

      await expect(
        service.executeIdempotent({
          consumer: 'worker-d',
          eventId: 'evt-203',
          handler: failingHandler,
        }),
      ).rejects.toThrow('S3 error');

      expect(mockClient.del).toHaveBeenCalledWith(
        'library:inbox:worker-d:evt-203',
      );
    });
  });

  describe('ExtractionHandler Integration with IdempotentConsumerService', () => {
    let idempotentConsumer: IdempotentConsumerService;
    let mockExtractionRepo: any;
    let mockPdf: any;
    let mockStoragePort: any;
    let mockSearchService: any;
    let handler: ExtractionHandler;

    beforeEach(() => {
      idempotentConsumer = new IdempotentConsumerService();
      idempotentConsumer.clearMemoryStore();

      mockExtractionRepo = {
        claimPendingOrRetryable: jest.fn().mockResolvedValue({ count: 1 }),
        claimStaleProcessing: jest.fn().mockResolvedValue({ count: 0 }),
        findUniqueAttachment: jest.fn().mockResolvedValue({
          id: 'att-1',
          itemId: 'item-1',
          fileId: 'file-1',
          filename: 'paper.pdf',
          extractionAttempts: 1,
          item: {
            id: 'item-1',
            title: 'Uploaded Document',
            userId: 'user-1',
          },
        }),
        saveMetadataSourceRecord: jest.fn().mockResolvedValue({ id: 'meta-1' }),
        updateItem: jest.fn().mockResolvedValue({}),
        countContributors: jest.fn().mockResolvedValue(1),
        markReady: jest.fn().mockResolvedValue({}),
        markFailed: jest.fn().mockResolvedValue({}),
      };

      mockPdf = {
        extractDocumentFromBuffer: jest.fn().mockResolvedValue({
          pages: [{ pageIndex: 0, text: 'Idempotency test content' }],
          metadata: {
            title: 'Attention Is All You Need',
          },
          sections: [],
          figures: [],
          tables: [],
          formulas: [],
          references: [],
        }),
      };

      mockStoragePort = {
        readOwnedFile: jest.fn().mockResolvedValue({
          fileId: 'file-1',
          buffer: Buffer.from('%PDF-1.4 mock content'),
        }),
        uploadFile: jest.fn().mockResolvedValue({
          fileId: 'grobid-storage-id',
          url: '/api/files/grobid-storage-id',
          path: 'extractions/item-1/grobid_fulltext.json.gz',
        }),
      };

      mockSearchService = {
        indexAttachmentPages: jest.fn().mockResolvedValue(undefined),
      };

      handler = new ExtractionHandler(
        mockExtractionRepo,
        mockPdf,
        mockStoragePort,
        mockSearchService,
        300000,
        idempotentConsumer,
      );
    });

    it('should process extraction on first event and mark inbox completed', async () => {
      const event = fromPartial<OutboxEvent>({
        id: 'event-extract-1',
        aggregateId: 'att-1',
        eventType: 'library.attachment.extraction_requested',
        payload: { attachmentId: 'att-1' },
      });

      await handler.handle(event);

      expect(mockExtractionRepo.claimPendingOrRetryable).toHaveBeenCalledWith('att-1');
      expect(mockPdf.extractDocumentFromBuffer).toHaveBeenCalledTimes(1);
      expect(mockExtractionRepo.markReady).toHaveBeenCalledWith('att-1');

      // Idempotent consumer should report completed
      const isDone = await idempotentConsumer.isProcessed(
        'ExtractionHandler',
        'event-extract-1',
      );
      expect(isDone).toBe(true);
    });

    it('should skip entire extraction pipeline when duplicate event arrives', async () => {
      const event = fromPartial<OutboxEvent>({
        id: 'event-extract-2',
        aggregateId: 'att-1',
        eventType: 'library.attachment.extraction_requested',
        payload: { attachmentId: 'att-1' },
      });

      // 1st arrival: executes
      await handler.handle(event);
      expect(mockPdf.extractDocumentFromBuffer).toHaveBeenCalledTimes(1);
      expect(mockExtractionRepo.claimPendingOrRetryable).toHaveBeenCalledTimes(1);

      // 2nd arrival (BullMQ duplicate redelivery): skipped by IdempotentConsumer
      await handler.handle(event);

      // Counts remain 1 (no duplicate PDF parsing or DB claim)
      expect(mockPdf.extractDocumentFromBuffer).toHaveBeenCalledTimes(1);
      expect(mockExtractionRepo.claimPendingOrRetryable).toHaveBeenCalledTimes(1);
    });

    it('should release lease upon extraction failure allowing BullMQ retry', async () => {
      const failingEvent = fromPartial<OutboxEvent>({
        id: 'event-extract-3',
        aggregateId: 'att-1',
        eventType: 'library.attachment.extraction_requested',
        payload: { attachmentId: 'att-1' },
      });

      // Make storage reading fail on first attempt
      mockStoragePort.readOwnedFile.mockRejectedValueOnce(
        new Error('S3 connection timeout'),
      );

      await expect(handler.handle(failingEvent)).rejects.toThrow(
        'S3 connection timeout',
      );

      // Should mark attachment failed
      expect(mockExtractionRepo.markFailed).toHaveBeenCalledWith(
        'att-1',
        'FAILED_RETRYABLE',
        'S3 connection timeout',
        false,
      );

      // Lease should be cleared so retry can execute
      const isDone = await idempotentConsumer.isProcessed(
        'ExtractionHandler',
        'event-extract-3',
      );
      expect(isDone).toBe(false);

      // Next attempt succeeds
      await handler.handle(failingEvent);
      expect(mockExtractionRepo.markReady).toHaveBeenCalledWith('att-1');
      expect(
        await idempotentConsumer.isProcessed(
          'ExtractionHandler',
          'event-extract-3',
        ),
      ).toBe(true);
    });
  });
});
