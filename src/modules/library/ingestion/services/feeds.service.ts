import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService, isUuid } from '@/core';
import { UrlCaptureService } from '@/modules/library/ingestion/services/url-capture.service';

export interface FeedSubscriptionDto {
  id: string;
  userId: string;
  feedId: string;
  customTitle: string | null;
  cleanupReadAfter: number;
  cleanupUnreadAfter: number;
  feed: {
    id: string;
    url: string;
    title: string;
    siteUrl: string | null;
    description: string | null;
    lastFetchedAt: Date | null;
  };
}

@Injectable()
export class FeedsService {
  private readonly logger = new Logger(FeedsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly urlCaptureService: UrlCaptureService,
  ) {}

  async getSubscriptions(userId: string): Promise<FeedSubscriptionDto[]> {
    const subs = await this.prisma.feedSubscription.findMany({
      where: { userId },
      include: {
        feed: {
          select: {
            id: true,
            url: true,
            title: true,
            siteUrl: true,
            description: true,
            lastFetchedAt: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return subs;
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

    // Ensure the feed exists and initial metadata is fetched
    let feed = await this.prisma.feed.findUnique({
      where: { url: cleanUrl },
    });

    if (!feed) {
      try {
        const fetched = await this.urlCaptureService.fetchAcademicFeed(cleanUrl);
        feed = await this.prisma.feed.findUnique({
          where: { url: cleanUrl },
        });
        if (!feed) {
          feed = await this.prisma.feed.create({
            data: {
              url: cleanUrl,
              title: fetched.feedTitle || cleanUrl,
              siteUrl: fetched.feedUrl || null,
              description: null,
            },
          });
        }
      } catch (err: unknown) {
        this.logger.warn(`Could not parse feed at ${cleanUrl} during subscribe: ${err}`);
        feed = await this.prisma.feed.create({
          data: {
            url: cleanUrl,
            title: customTitle || cleanUrl,
          },
        });
      }
    }

    const sub = await this.prisma.feedSubscription.upsert({
      where: {
        userId_feedId: {
          userId,
          feedId: feed.id,
        },
      },
      create: {
        userId,
        feedId: feed.id,
        customTitle: customTitle || null,
        cleanupReadAfter: cleanupDays,
        cleanupUnreadAfter: cleanupDays,
      },
      update: {
        customTitle: customTitle || undefined,
        cleanupReadAfter: cleanupDays,
        cleanupUnreadAfter: cleanupDays,
      },
      include: {
        feed: {
          select: {
            id: true,
            url: true,
            title: true,
            siteUrl: true,
            description: true,
            lastFetchedAt: true,
          },
        },
      },
    });

    return sub;
  }

  async unsubscribe(userId: string, feedId: string): Promise<void> {
    await this.prisma.feedSubscription.deleteMany({
      where: {
        userId,
        feedId,
      },
    });
  }

  async updateSubscription(
    userId: string,
    feedId: string,
    data: { customTitle?: string; cleanupDays?: number },
  ): Promise<FeedSubscriptionDto> {
    const existing = await this.prisma.feedSubscription.findUnique({
      where: {
        userId_feedId: { userId, feedId },
      },
    });
    if (!existing) {
      throw new NotFoundException('Subscription not found');
    }

    return this.prisma.feedSubscription.update({
      where: { id: existing.id },
      data: {
        ...(data.customTitle !== undefined ? { customTitle: data.customTitle } : {}),
        ...(data.cleanupDays !== undefined
          ? {
              cleanupReadAfter: data.cleanupDays,
              cleanupUnreadAfter: data.cleanupDays,
            }
          : {}),
      },
      include: {
        feed: {
          select: {
            id: true,
            url: true,
            title: true,
            siteUrl: true,
            description: true,
            lastFetchedAt: true,
          },
        },
      },
    });
  }

  async getFeedItems(
    userId: string,
    feedId: string,
    options?: { readStatus?: 'read' | 'unread' | 'all'; limit?: number },
  ) {
    const limit = Math.min(Math.max(options?.limit ?? 50, 1), 200);
    const readStatus = options?.readStatus ?? 'all';

    const items = await this.prisma.feedItem.findMany({
      where: {
        feedId,
        ...(readStatus === 'read'
          ? { readStates: { some: { userId } } }
          : readStatus === 'unread'
            ? { readStates: { none: { userId } } }
            : {}),
      },
      include: {
        readStates: {
          where: { userId },
          select: { readAt: true },
        },
      },
      orderBy: { publishedAt: 'desc' },
      take: limit,
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

  private async resolveFeedItemUuid(rawItemId: string): Promise<string | null> {
    if (!rawItemId || typeof rawItemId !== 'string') return null;
    const trimmed = rawItemId.trim();
    if (isUuid(trimmed)) return trimmed;

    // If identifier is a guid (like "oai:arXiv.org:2610.28686v1" or arXiv ID / URL)
    const found = await this.prisma.feedItem.findFirst({
      where: {
        OR: [
          { guid: trimmed },
          { url: trimmed },
          { doi: trimmed },
          { arxivId: trimmed },
        ],
      },
      select: { id: true },
    });

    return found?.id || null;
  }

  async markItemRead(userId: string, itemId: string, isRead = true): Promise<void> {
    const canonicalId = await this.resolveFeedItemUuid(itemId);
    if (!canonicalId) {
      this.logger.debug(
        `[FeedsService] Cannot record read state: FeedItem not found for identifier "${itemId}"`,
      );
      return;
    }

    if (isRead) {
      await this.prisma.feedItemReadState.upsert({
        where: {
          userId_itemId: { userId, itemId: canonicalId },
        },
        create: {
          userId,
          itemId: canonicalId,
        },
        update: {
          readAt: new Date(),
        },
      });
    } else {
      await this.prisma.feedItemReadState.deleteMany({
        where: { userId, itemId: canonicalId },
      });
    }
  }

  async markAllRead(userId: string, itemIds: string[]): Promise<void> {
    if (!itemIds || itemIds.length === 0) return;

    const resolvedIds = (
      await Promise.all(itemIds.map((id) => this.resolveFeedItemUuid(id)))
    ).filter((id): id is string => Boolean(id));

    if (resolvedIds.length === 0) return;

    const records = resolvedIds.map((canonicalId) => ({
      userId,
      itemId: canonicalId,
    }));
    await this.prisma.feedItemReadState.createMany({
      data: records,
      skipDuplicates: true,
    });
  }
}
