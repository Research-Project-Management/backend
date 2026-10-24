import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { UrlCaptureService } from '@/modules/library/ingestion/services/url-capture.service';
import {
  FeedsRepository,
  type FeedSubscriptionRecord,
} from '@/modules/library/ingestion/repositories/feeds.repository';

export type FeedSubscriptionDto = FeedSubscriptionRecord;

@Injectable()
export class FeedsService {
  private readonly logger = new Logger(FeedsService.name);

  constructor(
    private readonly feedsRepo: FeedsRepository,
    private readonly urlCaptureService: UrlCaptureService,
  ) {}

  async getSubscriptions(userId: string): Promise<FeedSubscriptionDto[]> {
    return this.feedsRepo.findSubscriptionsByUser(userId);
  }

  async subscribe(
    userId: string,
    url: string,
    customTitle?: string,
    cleanupDays = 30,
  ): Promise<FeedSubscriptionDto> {
    const cleanUrl = url.trim();
    if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) {
      throw new BadRequestException('A valid HTTP/HTTPS URL is required');
    }

    let feed = await this.feedsRepo.findFeedByUrl(cleanUrl);

    if (!feed) {
      try {
        const fetched = await this.urlCaptureService.fetchAcademicFeed(cleanUrl);
        feed = await this.feedsRepo.findFeedByUrl(cleanUrl);
        if (!feed) {
          feed = await this.feedsRepo.createFeed({
            url: cleanUrl,
            title: fetched.feedTitle || cleanUrl,
            siteUrl: fetched.feedUrl || null,
            description: null,
          });
        }
      } catch (err: unknown) {
        this.logger.warn(`Could not parse feed at ${cleanUrl} during subscribe: ${err}`);
        feed = await this.feedsRepo.createFeed({
          url: cleanUrl,
          title: customTitle || cleanUrl,
        });
      }
    }

    return this.feedsRepo.upsertSubscription({
      userId,
      feedId: feed.id,
      customTitle,
      cleanupDays,
    });
  }

  async unsubscribe(userId: string, feedId: string): Promise<void> {
    await this.feedsRepo.deleteSubscription(userId, feedId);
  }

  async updateSubscription(
    userId: string,
    feedId: string,
    data: { customTitle?: string; cleanupDays?: number },
  ): Promise<FeedSubscriptionDto> {
    const existing = await this.feedsRepo.findSubscription(userId, feedId);
    if (!existing) {
      throw new NotFoundException('Subscription not found');
    }

    return this.feedsRepo.updateSubscriptionById(existing.id, data);
  }

  async getFeedItems(
    userId: string,
    feedId: string,
    options?: { readStatus?: 'read' | 'unread' | 'all'; limit?: number },
  ) {
    const limit = Math.min(Math.max(options?.limit ?? 50, 1), 200);
    const readStatus = options?.readStatus ?? 'all';

    const items = await this.feedsRepo.findFeedItemsForUser({
      userId,
      feedId,
      readStatus,
      limit,
    });

    return items.map((it) => ({
      id: it.id,
      feedId: it.feedId,
      guid: it.guid,
      title: it.title,
      url: it.url,
      pdfUrl: it.pdfUrl,
      doi: it.doi,
      arxivId: it.arxivId,
      primaryCategory: it.primaryCategory,
      authors: it.authors,
      abstract: it.abstract,
      license: it.license,
      comments: it.comments,
      publishedAt: it.publishedAt,
      isRead: it.readStates.length > 0,
      readAt: it.readStates[0]?.readAt ?? null,
    }));
  }

  async markItemRead(userId: string, itemId: string, isRead = true): Promise<void> {
    const canonicalId = await this.feedsRepo.resolveFeedItemUuid(itemId);
    if (!canonicalId) {
      this.logger.debug(
        `[FeedsService] Cannot record read state: FeedItem not found for identifier "${itemId}"`,
      );
      return;
    }

    await this.feedsRepo.setItemReadState(userId, canonicalId, isRead);
  }

  async markAllRead(userId: string, itemIds: string[]): Promise<void> {
    if (!itemIds || itemIds.length === 0) return;

    const resolvedIds = await this.feedsRepo.resolveFeedItemUuids(
      itemIds.slice(0, 200),
    );

    if (resolvedIds.length === 0) return;

    await this.feedsRepo.markManyItemsRead(userId, resolvedIds);
  }
}
