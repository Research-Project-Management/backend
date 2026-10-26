import { Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService, isUuid } from '@/core';
import type { ParsedAcademicFeed } from '@/modules/library/ingestion/parsers/rss-atom-feed.parser';

export interface FeedSubscriptionRecord {
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

export interface CachedFeedWithItems {
  id: string;
  url: string;
  title: string;
  etag?: string | null;
  lastModified?: string | null;
  lastFetchedAt?: Date | null;
  items: Array<{
    id: string;
    title: string;
    url: string;
    pdfUrl?: string | null;
    doi?: string | null;
    arxivId?: string | null;
    primaryCategory?: string | null;
    authors?: unknown;
    abstract?: string | null;
    publishedAt?: Date | null;
    license?: string | null;
  }>;
}

const FEED_SUMMARY_SELECT = {
  id: true,
  url: true,
  title: true,
  siteUrl: true,
  description: true,
  lastFetchedAt: true,
} as const;

@Injectable()
export class FeedsRepository {
  constructor(@Optional() private readonly prisma?: PrismaService) {}

  get isAvailable(): boolean {
    return Boolean(this.prisma);
  }

  async findSubscriptionsByUser(userId: string): Promise<FeedSubscriptionRecord[]> {
    if (!this.prisma) return [];
    return this.prisma.feedSubscription.findMany({
      where: { userId },
      include: {
        feed: { select: FEED_SUMMARY_SELECT },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findFeedByUrl(url: string) {
    if (!this.prisma) return null;
    return this.prisma.feed.findUnique({ where: { url } });
  }

  async findFeedWithRecentItemsByUrl(
    url: string,
    take = 50,
  ): Promise<CachedFeedWithItems | null> {
    if (!this.prisma) return null;
    return this.prisma.feed.findUnique({
      where: { url },
      include: {
        items: {
          orderBy: { publishedAt: 'desc' },
          take,
        },
      },
    });
  }

  async createFeed(data: {
    url: string;
    title: string;
    siteUrl?: string | null;
    description?: string | null;
  }) {
    if (!this.prisma) {
      throw new ServiceUnavailableException('Database is unavailable');
    }
    return this.prisma.feed.create({ data });
  }

  async upsertSubscription(params: {
    userId: string;
    feedId: string;
    customTitle?: string;
    cleanupDays?: number;
    cleanupReadAfter?: number;
    cleanupUnreadAfter?: number;
  }): Promise<FeedSubscriptionRecord> {
    if (!this.prisma) {
      throw new ServiceUnavailableException('Database is unavailable');
    }
    const { userId, feedId, customTitle, cleanupDays } = params;
    const readDays =
      params.cleanupReadAfter !== undefined
        ? params.cleanupReadAfter
        : cleanupDays !== undefined
          ? cleanupDays
          : 7;
    const unreadDays =
      params.cleanupUnreadAfter !== undefined
        ? params.cleanupUnreadAfter
        : cleanupDays !== undefined
          ? cleanupDays
          : 30;
    return this.prisma.feedSubscription.upsert({
      where: {
        userId_feedId: { userId, feedId },
      },
      create: {
        userId,
        feedId,
        customTitle: customTitle || null,
        cleanupReadAfter: readDays,
        cleanupUnreadAfter: unreadDays,
      },
      update: {
        customTitle: customTitle || undefined,
        cleanupReadAfter: readDays,
        cleanupUnreadAfter: unreadDays,
      },
      include: {
        feed: { select: FEED_SUMMARY_SELECT },
      },
    });
  }

  async deleteSubscription(userId: string, feedId: string): Promise<void> {
    if (!this.prisma) return;
    await this.prisma.feedSubscription.deleteMany({
      where: { userId, feedId },
    });
  }

  async findSubscription(userId: string, feedId: string) {
    if (!this.prisma) return null;
    return this.prisma.feedSubscription.findFirst({
      where: {
        userId,
        OR: [{ feedId }, { id: feedId }],
      },
      include: {
        feed: { select: FEED_SUMMARY_SELECT },
      },
    });
  }

  async updateSubscriptionById(
    id: string,
    data: {
      customTitle?: string;
      cleanupDays?: number;
      cleanupReadAfter?: number;
      cleanupUnreadAfter?: number;
      feedId?: string;
    },
  ): Promise<FeedSubscriptionRecord> {
    if (!this.prisma) {
      throw new ServiceUnavailableException('Database is unavailable');
    }
    const nextReadAfter =
      data.cleanupReadAfter !== undefined
        ? data.cleanupReadAfter
        : data.cleanupDays;
    const nextUnreadAfter =
      data.cleanupUnreadAfter !== undefined
        ? data.cleanupUnreadAfter
        : data.cleanupDays;
    return this.prisma.feedSubscription.update({
      where: { id },
      data: {
        ...(data.customTitle !== undefined ? { customTitle: data.customTitle } : {}),
        ...(nextReadAfter !== undefined ? { cleanupReadAfter: nextReadAfter } : {}),
        ...(nextUnreadAfter !== undefined
          ? { cleanupUnreadAfter: nextUnreadAfter }
          : {}),
        ...(data.feedId ? { feedId: data.feedId } : {}),
      },
      include: {
        feed: { select: FEED_SUMMARY_SELECT },
      },
    });
  }

  async findFeedItemsForUser(params: {
    userId: string;
    feedId: string;
    readStatus: 'read' | 'unread' | 'all';
    limit: number;
    cleanupReadAfter?: number;
    cleanupUnreadAfter?: number;
  }) {
    if (!this.prisma) return [];
    const {
      userId,
      feedId,
      readStatus,
      limit,
      cleanupReadAfter,
      cleanupUnreadAfter,
    } = params;
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const readCutoff =
      cleanupReadAfter && cleanupReadAfter > 0
        ? new Date(now - cleanupReadAfter * dayMs)
        : null;
    const unreadCutoff =
      cleanupUnreadAfter && cleanupUnreadAfter > 0
        ? new Date(now - cleanupUnreadAfter * dayMs)
        : null;

    const rawItems = await this.prisma.feedItem.findMany({
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

    if (!readCutoff && !unreadCutoff) {
      return rawItems;
    }

    // Per-user virtualized retention window:
    // Shared physical `feed_items` stay intact for other subscribers,
    // while each user only sees items within their own read/unread retention window.
    return rawItems.filter((item) => {
      const isRead = item.readStates.length > 0;
      const pubTime = item.publishedAt ? new Date(item.publishedAt) : null;
      if (isRead) {
        if (!readCutoff) return true;
        const referenceDate = item.readStates[0]?.readAt
          ? new Date(item.readStates[0].readAt)
          : pubTime;
        return !referenceDate || referenceDate >= readCutoff;
      }
      if (!unreadCutoff) return true;
      return !pubTime || pubTime >= unreadCutoff;
    });
  }

  async resolveFeedItemUuid(rawItemId: string): Promise<string | null> {
    if (!rawItemId || typeof rawItemId !== 'string') return null;
    const trimmed = rawItemId.trim();
    if (isUuid(trimmed)) return trimmed;
    if (!this.prisma) return null;

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

  async resolveFeedItemUuids(rawItemIds: string[]): Promise<string[]> {
    if (!Array.isArray(rawItemIds) || rawItemIds.length === 0) return [];
    const uniqueRaw = Array.from(
      new Set(
        rawItemIds
          .filter((id): id is string => typeof id === 'string')
          .map((id) => id.trim())
          .filter(Boolean),
      ),
    ).slice(0, 200);

    const directUuids: string[] = [];
    const nonUuids: string[] = [];
    for (const id of uniqueRaw) {
      if (isUuid(id)) {
        directUuids.push(id);
      } else {
        nonUuids.push(id);
      }
    }

    if (nonUuids.length === 0 || !this.prisma) {
      return directUuids;
    }

    const foundItems = await this.prisma.feedItem.findMany({
      where: {
        OR: [
          { guid: { in: nonUuids } },
          { url: { in: nonUuids } },
          { doi: { in: nonUuids } },
          { arxivId: { in: nonUuids } },
        ],
      },
      select: { id: true },
      take: 200,
    });

    return Array.from(
      new Set([...directUuids, ...foundItems.map((it) => it.id)]),
    );
  }

  async setItemReadState(
    userId: string,
    canonicalItemId: string,
    isRead: boolean,
  ): Promise<void> {
    if (!this.prisma) return;
    if (isRead) {
      await this.prisma.feedItemReadState.upsert({
        where: {
          userId_itemId: { userId, itemId: canonicalItemId },
        },
        create: {
          userId,
          itemId: canonicalItemId,
        },
        update: {
          readAt: new Date(),
        },
      });
    } else {
      await this.prisma.feedItemReadState.deleteMany({
        where: { userId, itemId: canonicalItemId },
      });
    }
  }

  async markManyItemsRead(
    userId: string,
    canonicalItemIds: string[],
  ): Promise<void> {
    if (!this.prisma || canonicalItemIds.length === 0) return;
    await this.prisma.feedItemReadState.createMany({
      data: canonicalItemIds.map((itemId) => ({ userId, itemId })),
      skipDuplicates: true,
    });
  }

  async findActiveFeedsForPolling(take = 100) {
    if (!this.prisma) return [];
    return this.prisma.feed.findMany({
      where: { errorCount: { lt: 5 } },
      orderBy: { lastFetchedAt: { sort: 'asc', nulls: 'first' } },
      select: {
        id: true,
        url: true,
        lastFetchedAt: true,
      },
      take,
    });
  }

  async markFeedPollSuccess(feedId: string, status?: number): Promise<void> {
    if (!this.prisma) return;
    await this.prisma.feed
      .update({
        where: { id: feedId },
        data: {
          errorCount: 0,
          lastFetchedAt: new Date(),
          ...(status !== undefined ? { lastStatus: status } : {}),
        },
      })
      .catch(() => {});
  }

  async markFeedPollFailure(feedId: string): Promise<void> {
    if (!this.prisma) return;
    await this.prisma.feed
      .update({
        where: { id: feedId },
        data: { errorCount: { increment: 1 } },
      })
      .catch(() => {});
  }

  async findFeedsWithRetentionPreferences(take = 500) {
    if (!this.prisma) return [];
    return this.prisma.feed.findMany({
      select: {
        id: true,
        subscriptions: {
          select: {
            cleanupReadAfter: true,
            cleanupUnreadAfter: true,
          },
        },
      },
      take,
    });
  }

  async deleteFeedItemsOlderThan(
    cutoffDate: Date,
    feedId?: string,
  ): Promise<number> {
    if (!this.prisma) return 0;
    const res = await this.prisma.feedItem.deleteMany({
      where: {
        ...(feedId ? { feedId } : {}),
        publishedAt: { lt: cutoffDate },
      },
    });
    return res.count;
  }

  async persistFetchedFeedAndItems(params: {
    feedUrl: string;
    parsed: ParsedAcademicFeed;
    etag?: string;
    lastModified?: string;
  }): Promise<void> {
    if (!this.prisma) return;
    const prismaClient = this.prisma;
    const { feedUrl, parsed, etag, lastModified } = params;

    const feed = await this.prisma.feed.upsert({
      where: { url: feedUrl },
      create: {
        url: feedUrl,
        title: parsed.feedTitle || 'Academic Feed',
        siteUrl: undefined,
        description: undefined,
        etag,
        lastModified,
        lastFetchedAt: new Date(),
        lastStatus: 200,
        errorCount: 0,
      },
      update: {
        title: parsed.feedTitle || undefined,
        etag: etag || undefined,
        lastModified: lastModified || undefined,
        lastFetchedAt: new Date(),
        lastStatus: 200,
        errorCount: 0,
      },
    });

    if (!Array.isArray(parsed.entries) || parsed.entries.length === 0) return;

    const boundedEntries = parsed.entries.slice(0, 100);
    const UPSERT_CHUNK_SIZE = 15;
    for (let i = 0; i < boundedEntries.length; i += UPSERT_CHUNK_SIZE) {
      const chunk = boundedEntries.slice(i, i + UPSERT_CHUNK_SIZE);
      await Promise.all(
        chunk.map((entry) => {
          const guid = (
            entry.doi ||
            entry.arxivId ||
            entry.url ||
            entry.id ||
            entry.title ||
            ''
          ).trim();
          if (!guid || !entry.title) return Promise.resolve();

          const publishedDate = entry.publicationDate
            ? new Date(entry.publicationDate)
            : new Date();
          const validPublishedAt = isNaN(publishedDate.getTime())
            ? new Date()
            : publishedDate;

          const authorsJson = Array.isArray(entry.authors)
            ? entry.authors.map((a: string) => ({ name: a }))
            : [];

          return prismaClient.feedItem
            .upsert({
              where: {
                feedId_guid: {
                  feedId: feed.id,
                  guid,
                },
              },
              create: {
                feedId: feed.id,
                guid,
                title: entry.title,
                url: entry.url || feedUrl,
                pdfUrl: entry.pdfUrl,
                doi: entry.doi,
                arxivId: entry.arxivId,
                primaryCategory: entry.primaryCategory,
                authors: authorsJson,
                abstract: entry.abstract,
                license: entry.rights,
                comments: undefined,
                publishedAt: validPublishedAt,
              },
              update: {
                title: entry.title,
                url: entry.url || undefined,
                pdfUrl: entry.pdfUrl || undefined,
                doi: entry.doi || undefined,
                arxivId: entry.arxivId || undefined,
                primaryCategory: entry.primaryCategory || undefined,
                authors: authorsJson,
                abstract: entry.abstract || undefined,
                license: entry.rights || undefined,
              },
            })
            .catch(() => {});
        }),
      );
    }
  }

  mapCachedFeedToParsedFeed(cachedFeed: CachedFeedWithItems): ParsedAcademicFeed {
    return {
      format: 'atom',
      feedTitle: cachedFeed.title,
      feedUrl: cachedFeed.url,
      entries: (cachedFeed.items || []).map((it) => {
        const authors = Array.isArray(it.authors)
          ? (it.authors as Array<string | { name?: string }>).map((a) =>
              typeof a === 'string' ? a : a.name || '',
            )
          : [];
        return {
          id: it.id,
          title: it.title,
          url: it.url,
          pdfUrl: it.pdfUrl || undefined,
          doi: it.doi || undefined,
          arxivId: it.arxivId || undefined,
          primaryCategory: it.primaryCategory || undefined,
          authors,
          creators: authors.map((name) => ({
            firstName: '',
            lastName: name,
            fullName: name,
            creatorType: 'author' as const,
          })),
          abstract: it.abstract || undefined,
          publicationTitle: cachedFeed.title,
          publicationDate: it.publishedAt
            ? it.publishedAt.toISOString()
            : undefined,
          year: it.publishedAt
            ? new Date(it.publishedAt).getFullYear()
            : null,
          keywords: it.primaryCategory ? [it.primaryCategory] : [],
          rights: it.license || undefined,
          itemType: it.arxivId ? 'preprint' : 'journalArticle',
        };
      }),
    };
  }
}
