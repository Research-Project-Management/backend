import { IngestionService } from '@/modules/library/ingestion/ingestion.service';
import { PaperRepository } from '@/modules/library/paper/paper.repository';
import { BibtexFormatter } from '@/modules/library/reference/formatters/bibtex.formatter';
import { BibtexParser } from '@/modules/library/reference/parsers/bibtex.parser';
import { RisFormatter } from '@/modules/library/reference/formatters/ris.formatter';
import { DoiResolver } from '@/modules/library/reference/resolvers/doi.resolver';
import { UnifiedFetcherService } from '@/modules/library/reference/fetchers/unified-fetcher.service';
import { IngestionSourceType } from '@/modules/library/ingestion/dto/ingestion.dto';

describe('IngestionService (Async Batch Job Tracker)', () => {
  let service: IngestionService;
  let mockPaperRepo: any;
  let mockBibtexFormatter: BibtexFormatter;
  let mockBibtexParser: BibtexParser;
  let mockRisFormatter: RisFormatter;
  let mockDoiResolver: any;
  let mockUnifiedFetcher: any;

  beforeEach(() => {
    mockPaperRepo = {
      resolveWorkspace: jest.fn().mockResolvedValue({ id: 'ws-1' }),
      resolveUniqueCitationKey: jest.fn().mockResolvedValue('Doe2026'),
      createPaper: jest.fn().mockImplementation((data) =>
        Promise.resolve({
          id: 'paper-new-id',
          ...data,
        }),
      ),
    };

    mockBibtexFormatter = new BibtexFormatter();
    mockBibtexParser = new BibtexParser();
    mockRisFormatter = new RisFormatter();
    mockDoiResolver = {
      resolve: jest.fn().mockResolvedValue(null),
    };
    mockUnifiedFetcher = {
      resolve: jest.fn().mockResolvedValue(null),
    };

    service = new IngestionService(
      mockPaperRepo,
      mockBibtexFormatter,
      mockBibtexParser,
      mockRisFormatter,
      mockDoiResolver,
      mockUnifiedFetcher,
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

    const res = await service.createAsyncBatchJob('user-1', dto);

    expect(res.jobId).toBeDefined();
    expect(res.status).toBe('processing');
    expect(res.total).toBe(2);

    const status = service.getJobStatus(res.jobId);
    expect(status).toBeDefined();
    expect(status.jobId).toBe(res.jobId);
  });
});
