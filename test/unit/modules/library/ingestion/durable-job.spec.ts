import { JobsService as IngestionJobService } from '@/modules/library/legacy/translation/jobs.service';
import { TranslationSourceType as IngestionSourceType } from '@/modules/library/legacy/translation/dto/translation.dto';
import { IngestionState } from '@/modules/library/legacy/translation/jobs.state';

describe('IngestionJobService (Durable Queue Engine & Retry Policy)', () => {
  let service: IngestionJobService;
  let mockIngestionService: any;
  let mockRedis: any;

  beforeEach(() => {
    mockIngestionService = {
      ingest: jest.fn(),
    };

    mockRedis = {
      isReady: jest.fn().mockReturnValue(true),
      set: jest.fn().mockResolvedValue(true),
      get: jest.fn().mockResolvedValue(null),
      del: jest.fn().mockResolvedValue(true),
    };

    service = new IngestionJobService(mockIngestionService, mockRedis);
  });

  it('creates and executes an async batch job through completion', async () => {
    mockIngestionService.ingest.mockImplementation(
      (_userId: string, item: any) => {
        return Promise.resolve({
          id: `paper-${item.doi}`,
          title: `Title for ${item.doi}`,
        });
      },
    );

    const dto = {
      items: [
        {
          workspaceId: 'ws-1',
          sourceType: IngestionSourceType.DOI,
          doi: '10.1038/nature12345',
        },
        {
          workspaceId: 'ws-1',
          sourceType: IngestionSourceType.DOI,
          doi: '10.1038/nature67890',
        },
      ],
    };

    const initial = await service.createAsyncBatchJob('user-1', dto);
    expect(initial.jobId).toBeDefined();
    expect(initial.total).toBe(2);

    // Wait briefly for background execution
    await new Promise((r) => setTimeout(r, 50));

    const status = await service.getJobStatus(initial.jobId, 'user-1');
    expect(status.status).toBe('completed');
    expect(status.successCount).toBe(2);
    expect(status.failedCount).toBe(0);
    expect(status.progressPercentage).toBe(100);
    expect(status.successful.length).toBe(2);
    expect(status.items?.[0].state).toBe(IngestionState.PROMOTED);
  });

  it('retries recoverable network errors with backoff and succeeds on subsequent attempt', async () => {
    let callCount = 0;
    mockIngestionService.ingest.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        const timeoutErr = Object.assign(
          new Error('connect ETIMEDOUT 104.18.25.10:443'),
          { status: 504 },
        );
        return Promise.reject(timeoutErr);
      }
      return Promise.resolve({
        id: 'paper-recovered',
        title: 'Recovered Title',
      });
    });

    const dto = {
      items: [
        {
          workspaceId: 'ws-1',
          sourceType: IngestionSourceType.DOI,
          doi: '10.1038/retryable',
        },
      ],
    };

    const initial = await service.createAsyncBatchJob('user-1', dto);

    // Wait for the retry loop (1 retry with initial backoff ~500ms)
    await new Promise((r) => setTimeout(r, 700));

    const status = await service.getJobStatus(initial.jobId, 'user-1');
    expect(status.status).toBe('completed');
    expect(status.successCount).toBe(1);
    expect(status.items?.[0].attempts).toBe(2);
    expect(status.items?.[0].status).toBe('success');
    expect(status.items?.[0].state).toBe(IngestionState.PROMOTED);
  });

  it('marks unrecoverable errors as failed_unrecoverable without infinite retries', async () => {
    mockIngestionService.ingest.mockRejectedValue(
      new Error('Invalid DOI format: 10.invalid'),
    );

    const dto = {
      items: [
        {
          workspaceId: 'ws-1',
          sourceType: IngestionSourceType.DOI,
          doi: '10.invalid',
        },
      ],
    };

    const initial = await service.createAsyncBatchJob('user-1', dto);

    await new Promise((r) => setTimeout(r, 50));

    const status = await service.getJobStatus(initial.jobId, 'user-1');
    expect(status.status).toBe('failed');
    expect(status.failedCount).toBe(1);
    expect(status.items?.[0].attempts).toBe(1);
    expect(status.items?.[0].status).toBe('failed_unrecoverable');
    expect(status.items?.[0].state).toBe(IngestionState.FAILED_UNRECOVERABLE);
  });

  it('cancels a running job and aborts in-flight item executions', async () => {
    const dto = {
      items: Array.from({ length: 10 }, (_, i) => ({
        workspaceId: 'ws-1',
        sourceType: IngestionSourceType.DOI,
        doi: `10.1038/test-${i}`,
      })),
    };

    const initial = await service.createAsyncBatchJob('user-1', dto);
    const cancelRes = await service.cancelJob(initial.jobId, 'user-1');

    expect(cancelRes.success).toBe(true);

    const status = await service.getJobStatus(initial.jobId, 'user-1');
    expect(status.status).toBe('cancelled');
  });
});
