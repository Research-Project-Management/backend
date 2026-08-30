import { OutboxWorker } from '../../../src/modules/library/sync/workers/outbox.worker';
import { OutboxStatus } from '@prisma/client';
import { SyncMetricsService } from '../../../src/modules/library/sync/metrics/sync.metrics';
import {
  SYNC_EVENT_TYPES,
  LIBRARY_EVENT_CATALOG,
} from '../../../src/modules/library/sync/events/library.events';

describe('OutboxWorker (Atomic Lease, Heartbeat & Recovery)', () => {
  let worker: OutboxWorker;
  let mockPrisma: any;
  let metricsService: SyncMetricsService;

  beforeEach(() => {
    mockPrisma = {
      outboxEvent: {
        findMany: jest.fn(),
        updateMany: jest.fn(),
        count: jest.fn(),
      },
    };

    metricsService = new SyncMetricsService();
    worker = new OutboxWorker(mockPrisma, undefined, metricsService);
  });

  it('optimistically claims events with atomic updateMany and lease acquisition', async () => {
    const dummyEvent = {
      id: 'evt-1',
      eventType: 'test.event',
      status: OutboxStatus.PENDING,
      retryCount: 0,
      scheduledAt: new Date(),
    };

    mockPrisma.outboxEvent.findMany.mockResolvedValue([dummyEvent]);
    // Claim succeeds
    mockPrisma.outboxEvent.updateMany.mockResolvedValue({ count: 1 });

    const mockHandler = { handle: jest.fn().mockResolvedValue(undefined) };
    worker.registerHandler('test.event', mockHandler);

    const res = await worker.processPendingEvents(50, 60000);

    expect(mockPrisma.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'evt-1',
        OR: [
          {
            status: OutboxStatus.PENDING,
            OR: [
              { scheduledAt: null },
              { scheduledAt: { lte: expect.any(Date) } },
            ],
          },
          {
            status: OutboxStatus.PROCESSING,
            leaseExpiresAt: { lte: expect.any(Date) },
          },
        ],
      },
      data: {
        status: OutboxStatus.PROCESSING,
        claimedAt: expect.any(Date),
        leaseExpiresAt: expect.any(Date),
        claimedBy: worker.getWorkerId(),
      },
    });
    expect(mockHandler.handle).toHaveBeenCalledWith(
      dummyEvent,
      expect.anything(),
    );
    expect(mockPrisma.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'evt-1',
        status: OutboxStatus.PROCESSING,
        claimedBy: worker.getWorkerId(),
      },
      data: {
        status: OutboxStatus.PUBLISHED,
        processedAt: expect.any(Date),
        claimedAt: null,
        leaseExpiresAt: null,
        claimedBy: null,
        error: null,
      },
    });
    expect(res.processed).toBe(1);
  });

  it('reclaims expired PROCESSING events when a previous worker died', async () => {
    const expiredProcessingEvent = {
      id: 'evt-expired',
      eventType: 'test.event',
      status: OutboxStatus.PROCESSING,
      claimedBy: 'dead-worker-pid-999',
      leaseExpiresAt: new Date(Date.now() - 5000), // Expired 5 seconds ago
      retryCount: 0,
    };

    mockPrisma.outboxEvent.findMany.mockResolvedValue([expiredProcessingEvent]);
    mockPrisma.outboxEvent.updateMany.mockResolvedValue({ count: 1 });

    const mockHandler = { handle: jest.fn().mockResolvedValue(undefined) };
    worker.registerHandler('test.event', mockHandler);

    const res = await worker.processPendingEvents();

    expect(res.reclaimed).toBe(1);
    expect(res.processed).toBe(1);
    expect(mockHandler.handle).toHaveBeenCalledWith(
      expiredProcessingEvent,
      expect.anything(),
    );
    expect(metricsService.getCounter('outbox_lease_reclaimed_total')).toBe(1);
  });

  it('skips event if claim fails (concurrency race won by another worker instance)', async () => {
    const dummyEvent = {
      id: 'evt-2',
      eventType: 'test.event',
      status: OutboxStatus.PENDING,
      retryCount: 0,
    };

    mockPrisma.outboxEvent.findMany.mockResolvedValue([dummyEvent]);
    // Claim fails (0 rows updated)
    mockPrisma.outboxEvent.updateMany.mockResolvedValue({ count: 0 });

    const mockHandler = { handle: jest.fn() };
    worker.registerHandler('test.event', mockHandler);

    const res = await worker.processPendingEvents();

    expect(mockHandler.handle).not.toHaveBeenCalled();
    expect(res.processed).toBe(0);
  });

  it('never marks unhandled events as PUBLISHED; preserves PENDING with backoff and clears lease', async () => {
    const unhandledEvent = {
      id: 'evt-unhandled',
      eventType: 'unknown.future.event',
      status: OutboxStatus.PENDING,
      retryCount: 0,
    };

    mockPrisma.outboxEvent.findMany.mockResolvedValue([unhandledEvent]);
    mockPrisma.outboxEvent.updateMany.mockResolvedValue({ count: 1 });

    const res = await worker.processPendingEvents();

    expect(mockPrisma.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'evt-unhandled',
        status: OutboxStatus.PROCESSING,
        claimedBy: worker.getWorkerId(),
      },
      data: {
        status: OutboxStatus.PENDING,
        retryCount: 1,
        scheduledAt: expect.any(Date),
        claimedAt: null,
        leaseExpiresAt: null,
        claimedBy: null,
      },
    });
    expect(res.processed).toBe(0);
  });

  it('moves event to FAILED / DLQ when retry limit is exceeded and clears lease', async () => {
    const failingEvent = {
      id: 'evt-fail',
      eventType: 'failing.event',
      status: OutboxStatus.PENDING,
      retryCount: 4, // Next will be 5 (maxRetries)
    };

    mockPrisma.outboxEvent.findMany.mockResolvedValue([failingEvent]);
    mockPrisma.outboxEvent.updateMany.mockResolvedValue({ count: 1 });

    const mockHandler = {
      handle: jest.fn().mockRejectedValue(new Error('Persistent remote error')),
    };
    worker.registerHandler('failing.event', mockHandler);

    const res = await worker.processPendingEvents();

    expect(mockPrisma.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'evt-fail',
        status: OutboxStatus.PROCESSING,
        claimedBy: worker.getWorkerId(),
      },
      data: {
        status: OutboxStatus.FAILED,
        retryCount: 5,
        error: 'Persistent remote error',
        claimedAt: null,
        leaseExpiresAt: null,
        claimedBy: null,
      },
    });
    expect(res.deadLettered).toBe(1);
    expect(metricsService.getCounter('outbox_dlq_total')).toBe(1);
  });

  it('provides diagnostic summary of queue depths and unhandled types', async () => {
    worker.registerHandler('known.event', { handle: jest.fn() });

    mockPrisma.outboxEvent.findMany.mockResolvedValue([
      { eventType: 'known.event', createdAt: new Date(Date.now() - 30000) },
      { eventType: 'unhandled.event', createdAt: new Date(Date.now() - 10000) },
    ]);
    mockPrisma.outboxEvent.count.mockResolvedValue(1);

    const summary = await worker.getDiagnosticSummary();

    expect(summary.workerId).toBe(worker.getWorkerId());
    expect(summary.registeredHandlers).toContain('known.event');
    expect(summary.totalPending).toBe(2);
    expect(summary.totalProcessing).toBe(1);
    expect(summary.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(29);
    expect(summary.unhandledEventTypes).toEqual(['unhandled.event']);
  });

  it('aborts AbortSignal and halts processing when heartbeat lease is lost', async () => {
    const longRunningEvent = {
      id: 'evt-long',
      eventType: 'long.event',
      status: OutboxStatus.PENDING,
      retryCount: 0,
    };

    mockPrisma.outboxEvent.findMany.mockResolvedValue([longRunningEvent]);
    // First updateMany: claim succeeds
    // Second updateMany (heartbeat renewal): returns count 0 (lost lease)
    // Third updateMany: none
    let callCount = 0;
    mockPrisma.outboxEvent.updateMany.mockImplementation(async (args: any) => {
      callCount++;
      if (callCount === 1) return { count: 1 }; // Claim
      if (args.data?.leaseExpiresAt) return { count: 0 }; // Heartbeat renewal fails
      return { count: 1 };
    });

    let observedSignal: AbortSignal | undefined;
    const mockHandler = {
      handle: jest.fn(async (evt: any, signal?: AbortSignal) => {
        observedSignal = signal;
        // Wait briefly for heartbeat interval to trigger renewal
        await new Promise((r) => setTimeout(r, 1200));
      }),
    };
    worker.registerHandler('long.event', mockHandler);

    const res = await worker.processPendingEvents(50, 3000); // 3000ms lease -> 1000ms heartbeat

    expect(mockHandler.handle).toHaveBeenCalledWith(
      longRunningEvent,
      expect.any(Object),
    );
    expect(observedSignal?.aborted).toBe(true);
    expect(
      metricsService.getCounter('outbox_lease_lost_total'),
    ).toBeGreaterThanOrEqual(1);
  });

  it('asserts 100% of defined library event types are documented in event catalog', () => {
    for (const [key, eventType] of Object.entries(SYNC_EVENT_TYPES)) {
      expect(LIBRARY_EVENT_CATALOG[eventType as string]).toBeDefined();
      expect(LIBRARY_EVENT_CATALOG[eventType as string].producer).toBeTruthy();
      expect(LIBRARY_EVENT_CATALOG[eventType as string].consumer).toBeTruthy();
      expect(
        LIBRARY_EVENT_CATALOG[eventType as string].expectedSideEffect,
      ).toBeTruthy();
    }
  });
});
