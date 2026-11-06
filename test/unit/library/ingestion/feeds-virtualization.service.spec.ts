import { FeedsService } from '@/modules/library/ingestion/services/feeds.service';
import { FeedsRepository, type FeedSubscriptionRecord } from '@/modules/library/ingestion/repositories/feeds.repository';
import { FeedRetrievalService } from '@/modules/library/ingestion/services/feed-retrieval.service';

describe('FeedsService (Client-Side Protocol Virtualization Fast-Path)', () => {
  const USER_ID = '11111111-1111-4111-8111-111111111111';
  const FEED_ID = '22222222-2222-4222-8222-222222222222';

  let service: FeedsService;
  let mockFeedsRepo: {
    findFeedByUrl: jest.Mock;
    createFeed: jest.Mock;
    upsertSubscription: jest.Mock;
    findSubscription: jest.Mock;
    updateSubscriptionById: jest.Mock;
  };
  let mockFeedRetrieval: {
    fetchAcademicFeed: jest.Mock;
  };

  beforeEach(() => {
    mockFeedsRepo = {
      findFeedByUrl: jest.fn().mockResolvedValue(null),
      createFeed: jest.fn().mockImplementation(async (data: { url: string; title: string }) => ({
        id: FEED_ID,
        url: data.url,
        title: data.title,
      })),
      upsertSubscription: jest.fn().mockImplementation(
        async (data: { userId: string; feedId: string; customTitle?: string }) =>
          ({
            id: 'sub-1',
            userId: data.userId,
            feedId: data.feedId,
            customTitle: data.customTitle ?? null,
          }) as unknown as FeedSubscriptionRecord,
      ),
      findSubscription: jest.fn().mockResolvedValue({
        id: 'sub-1',
        userId: USER_ID,
        feedId: FEED_ID,
        customTitle: 'arXiv: cs.AI',
        feed: {
          id: FEED_ID,
          url: 'https://rss.arxiv.org/rss/cs.AI',
        },
      }),
      updateSubscriptionById: jest.fn().mockImplementation(
        async (id: string, data: { customTitle?: string; feedId?: string }) =>
          ({
            id,
            userId: USER_ID,
            feedId: data.feedId || FEED_ID,
            customTitle: data.customTitle ?? null,
          }) as unknown as FeedSubscriptionRecord,
      ),
    };

    mockFeedRetrieval = {
      fetchAcademicFeed: jest.fn().mockResolvedValue({
        feedTitle: 'Server Fetched Title',
        feedUrl: 'https://rss.arxiv.org/rss/cs.AI',
        entries: [],
      }),
    };

    service = new FeedsService(
      mockFeedsRepo as unknown as FeedsRepository,
      mockFeedRetrieval as unknown as FeedRetrievalService,
    );
  });

  it('skips server-side fetchAcademicFeed during subscribe when client virtualizer already resolved customTitle', async () => {
    const result = await service.subscribe(
      USER_ID,
      'https://rss.arxiv.org/rss/cs.AI',
      'arXiv: cs.AI (Artificial Intelligence)',
    );

    expect(mockFeedRetrieval.fetchAcademicFeed).not.toHaveBeenCalled();
    expect(mockFeedsRepo.createFeed).toHaveBeenCalledWith({
      url: 'https://rss.arxiv.org/rss/cs.AI',
      title: 'arXiv: cs.AI (Artificial Intelligence)',
      siteUrl: 'https://rss.arxiv.org/rss/cs.AI',
      description: null,
    });
    expect(result.feedId).toBe(FEED_ID);
  });

  it('falls back to server-side fetchAcademicFeed when no resolved customTitle is provided', async () => {
    await service.subscribe(USER_ID, 'https://blog.example.com/feed.xml');

    expect(mockFeedRetrieval.fetchAcademicFeed).toHaveBeenCalledWith(
      'https://blog.example.com/feed.xml',
    );
    expect(mockFeedsRepo.createFeed).toHaveBeenCalledWith({
      url: 'https://blog.example.com/feed.xml',
      title: 'Server Fetched Title',
      siteUrl: 'https://rss.arxiv.org/rss/cs.AI',
      description: null,
    });
  });

  it('skips server-side fetchAcademicFeed during updateSubscription when URL changes with a resolved customTitle', async () => {
    await service.updateSubscription(USER_ID, FEED_ID, {
      url: 'https://www.nature.com/nature.rss',
      customTitle: 'Nature',
    });

    expect(mockFeedRetrieval.fetchAcademicFeed).not.toHaveBeenCalled();
    expect(mockFeedsRepo.createFeed).toHaveBeenCalledWith({
      url: 'https://www.nature.com/nature.rss',
      title: 'Nature',
      siteUrl: 'https://www.nature.com/nature.rss',
      description: null,
    });
  });
});
