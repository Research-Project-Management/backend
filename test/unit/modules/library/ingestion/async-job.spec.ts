import { JobsService as IngestionJobService } from '@/modules/library/legacy/translation/jobs.service';
import { TranslationSourceType as IngestionSourceType } from '@/modules/library/legacy/translation/dto/translation.dto';

describe('IngestionJobService (Async Batch Job Tracker)', () => {
  let jobService: IngestionJobService;
  let mockIngestionService: any;

  beforeEach(() => {
    // IngestionJobService delegates actual ingestion to IngestionService.ingest()
    mockIngestionService = {
      ingest: jest.fn().mockImplementation((userId, item) =>
        Promise.resolve({
          id: 'paper-new-id',
          title: item.title || 'Batch Paper',
          citationKey: 'doe2026batch',
          sourceType: item.sourceType,
          authors: [],
        }),
      ),
    };

    // Inject mock IngestionService via forwardRef token
    jobService = new (IngestionJobService as any)(
      mockIngestionService,
      undefined /* no Redis in unit tests */,
    );
  });

  it('should enqueue an async batch ingestion job and return trackable Job ID', async () => {
    const dto = {
      workspaceId: 'ws-1',
      items: [
        {
          workspaceId: 'ws-1',
          sourceType: IngestionSourceType.PDF,
          title: 'Batch Paper 1',
          fileUrl: 'https://cdn.example.com/p1.pdf',
        },
        {
          workspaceId: 'ws-1',
          sourceType: IngestionSourceType.PDF,
          title: 'Batch Paper 2',
          fileUrl: 'https://cdn.example.com/p2.pdf',
        },
      ],
    };

    const res = await jobService.createAsyncBatchJob('user-1', dto);

    expect(res.jobId).toBeDefined();
    expect(res.status).toBe('processing');
    expect(res.total).toBe(2);

    const status = await jobService.getJobStatus(res.jobId, 'user-1');
    expect(status).toBeDefined();
    expect(status.jobId).toBe(res.jobId);
  });
});
