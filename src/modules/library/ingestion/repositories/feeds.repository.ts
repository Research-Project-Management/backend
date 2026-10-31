import { Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService, isUuid } from '@/core';
import { parseCreatorString } from '@/modules/library/core';
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
    guid?: string | null;
    comments?: string | null;
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
  private readonly logger = new Logger(FeedsRepository.name);
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
      where: { userId, OR: [{ feedId }, { id: feedId }] },
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

    const retentionConditions: Prisma.FeedItemWhereInput[] = [];
    if (readCutoff) {
      retentionConditions.push({
        OR: [
          { readStates: { none: { userId } } },
          { readStates: { some: { userId, readAt: { gte: readCutoff } } } },
        ],
      });
    }
    if (unreadCutoff) {
      retentionConditions.push({
        OR: [
          { readStates: { some: { userId } } },
          { publishedAt: { gte: unreadCutoff } },
        ],
      });
    }

    const rawItems = await this.prisma.feedItem.findMany({
      where: {
        feedId,
        ...(readStatus === 'read'
          ? { readStates: { some: { userId } } }
          : readStatus === 'unread'
            ? { readStates: { none: { userId } } }
            : {}),
        ...(retentionConditions.length > 0 ? { AND: retentionConditions } : {}),
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

  async resolveFeedItemUuid(rawItemId: string, userId?: string): Promise<string | null> {
    if (!rawItemId || typeof rawItemId !== 'string') return null;
    const trimmed = rawItemId.trim();
    if (!this.prisma?.feedItem?.findFirst) return isUuid(trimmed) ? trimmed : null;
    const found = await this.prisma.feedItem.findFirst({
      where: {
        ...(userId ? { feed: { subscriptions: { some: { userId } } } } : {}),
        OR: [
          ...(isUuid(trimmed) ? [{ id: trimmed }] : []),
          { guid: trimmed },
          { url: trimmed },
          { doi: trimmed },
          { arxivId: trimmed },
        ],
      },
      select: { id: true },
    });
    return found?.id || (isUuid(trimmed) && !userId ? trimmed : null);
  }

  async resolveFeedItemUuids(rawItemIds: string[], userId?: string): Promise<string[]> {
    if (!Array.isArray(rawItemIds) || rawItemIds.length === 0) return [];
    const uniqueRaw = Array.from(
      new Set(rawItemIds.filter((id): id is string => typeof id === 'string').map((id) => id.trim()).filter(Boolean)),
    ).slice(0, 200);
    const directUuids: string[] = [];
    const nonUuids: string[] = [];
    for (const id of uniqueRaw) {
      if (isUuid(id)) directUuids.push(id);
      else nonUuids.push(id);
    }
    if ((nonUuids.length === 0 && !userId) || !this.prisma) return directUuids;
    const orFilters: Prisma.FeedItemWhereInput[] = [
      ...(directUuids.length > 0 ? [{ id: { in: directUuids } }] : []),
      ...(nonUuids.length > 0 ? [{ guid: { in: nonUuids } }, { url: { in: nonUuids } }, { doi: { in: nonUuids } }, { arxivId: { in: nonUuids } }] : []),
    ];
    if (orFilters.length === 0) return [];
    const foundItems = await this.prisma.feedItem.findMany({
      where: {
        ...(userId ? { feed: { subscriptions: { some: { userId } } } } : {}),
        OR: orFilters,
      },
      select: { id: true },
      take: 200,
    });
    return Array.from(new Set([...(userId ? [] : directUuids), ...foundItems.map((it) => it.id)]));
  }

  async setItemReadState(userId: string, canonicalItemId: string, isRead: boolean): Promise<void> {
    if (!this.prisma) return;
    let resolvedId = canonicalItemId;
    if (!isUuid(canonicalItemId)) {
      const found = await this.resolveFeedItemUuid(canonicalItemId);
      if (!found) return;
      resolvedId = found;
    }
    if (isRead) {
      await this.prisma.feedItemReadState.upsert({
        where: { userId_itemId: { userId, itemId: resolvedId } },
        create: { userId, itemId: resolvedId },
        update: { readAt: new Date() },
      });
    } else {
      await this.prisma.feedItemReadState.deleteMany({ where: { userId, itemId: resolvedId } });
    }
  }

  async markItemRead(userId: string, feedItemId: string, isRead = true): Promise<void> {
    const resolvedId = await this.resolveFeedItemUuid(feedItemId);
    if (!resolvedId) return;
    await this.setItemReadState(userId, resolvedId, isRead);
  }

  async findReadItemIdsForUser(userId: string, itemIds: string[]): Promise<Set<string>> {
    if (!this.prisma?.feedItemReadState?.findMany || itemIds.length === 0) return new Set();
    const validIds = itemIds.filter((id) => isUuid(id));
    if (validIds.length === 0) return new Set();
    const states = await this.prisma.feedItemReadState.findMany({
      where: { userId, itemId: { in: validIds } },
      select: { itemId: true },
    });
    return new Set(states.map((s) => s.itemId));
  }

  async markManyItemsRead(userId: string, canonicalItemIds: string[]): Promise<void> {
    if (!this.prisma || canonicalItemIds.length === 0) return;
    await this.prisma.feedItemReadState.createMany({
      data: canonicalItemIds.map((itemId) => ({ userId, itemId })),
      skipDuplicates: true,
    });
  }

  async findActiveFeedsForPolling(take = 100) {
    if (!this.prisma) return [];
    const feeds = await this.prisma.feed.findMany({
      where: { errorCount: { lt: 5 }, subscriptions: { some: {} } },
      orderBy: { lastFetchedAt: { sort: 'asc', nulls: 'first' } },
      select: { id: true, url: true, lastFetchedAt: true, refreshInterval: true },
      take,
    });
    const now = Date.now();
    return feeds.filter((feed) => {
      if (!feed.lastFetchedAt) return true;
      const intervalSec = typeof feed.refreshInterval === 'number' && feed.refreshInterval > 0 ? feed.refreshInterval : 7200;
      return now - new Date(feed.lastFetchedAt).getTime() >= intervalSec * 1000;
    });
  }

  async markFeedPollSuccess(feedId: string, status?: number): Promise<void> {
    if (!this.prisma) return;
    await this.prisma.feed.update({
      where: { id: feedId },
      data: { errorCount: 0, lastFetchedAt: new Date(), ...(status !== undefined ? { lastStatus: status } : {}) },
    }).catch((err: unknown) => this.logger.warn(`Failed to update feed poll state (${feedId}): ${err instanceof Error ? err.message : String(err)}`));
  }

  async markFeedPollFailure(feedId: string): Promise<void> {
    if (!this.prisma) return;
    await this.prisma.feed.update({
      where: { id: feedId },
      data: { errorCount: { increment: 1 } },
    }).catch((err: unknown) => this.logger.warn(`Failed to update feed poll state (${feedId}): ${err instanceof Error ? err.message : String(err)}`));
  }

  async findFeedsWithRetentionPreferences(take = 500) {
    if (!this.prisma) return [];
    return this.prisma.feed.findMany({
      select: { id: true, subscriptions: { select: { cleanupReadAfter: true, cleanupUnreadAfter: true } } },
      take,
    });
  }

  async deleteFeedItemsOlderThan(cutoffDate: Date, feedId?: string, readStatus?: 'read' | 'unread'): Promise<number> {
    if (!this.prisma) return 0;
    const whereClause: Prisma.FeedItemWhereInput = {
      ...(feedId ? { feedId } : {}),
      publishedAt: { lt: cutoffDate },
      ...(readStatus === 'read' ? { readStates: { some: {} } } : readStatus === 'unread' ? { readStates: { none: {} } } : {}),
    };
    const res = await this.prisma.feedItem.deleteMany({ where: whereClause });
    return res.count;
  }

  async persistFetchedFeedAndItems(params: {
    feedUrl: string;
    parsed: ParsedAcademicFeed;
    etag?: string;
    lastModified?: string;
  }): Promise<CachedFeedWithItems | void> {
    if (!this.prisma) return;
    const prismaClient = this.prisma;
    const { feedUrl, parsed, etag, lastModified } = params;
    const resolvedSiteUrl = parsed.siteUrl || parsed.feedUrl || undefined;

    const feed = await this.prisma.feed.upsert({
      where: { url: feedUrl },
      create: {
        url: feedUrl,
        title: parsed.feedTitle || 'Academic Feed',
        siteUrl: resolvedSiteUrl,
        description: parsed.description || undefined,
        etag,
        lastModified,
        lastFetchedAt: new Date(),
        lastStatus: 200,
        errorCount: 0,
      },
      update: {
        title: parsed.feedTitle || undefined,
        ...(resolvedSiteUrl ? { siteUrl: resolvedSiteUrl } : {}),
        ...(parsed.description ? { description: parsed.description } : {}),
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
    const persistedItems: CachedFeedWithItems['items'] = [];
    for (let i = 0; i < boundedEntries.length; i += UPSERT_CHUNK_SIZE) {
      const chunk = boundedEntries.slice(i, i + UPSERT_CHUNK_SIZE);
      const chunkRes = await Promise.all(
        chunk.map(async (entry) => {
          const guid = (
            entry.doi ||
            entry.arxivId ||
            entry.url ||
            entry.id ||
            entry.title ||
            ''
          ).trim();
          if (!guid || !entry.title) return null;

          const publishedDate = entry.publicationDate
            ? new Date(entry.publicationDate)
            : new Date();
          const validPublishedAt = isNaN(publishedDate.getTime())
            ? new Date()
            : publishedDate;

          const authorsJson =
            Array.isArray(entry.creators) && entry.creators.length > 0
              ? entry.creators.map((c, cIdx) => {
                  const needsReparse =
                    !c.firstName &&
                    c.lastName &&
                    c.lastName.includes(' ') &&
                    c.fieldMode !== 1;
                  const resolved = needsReparse
                    ? parseCreatorString(
                        c.lastName || '',
                        cIdx,
                        c.creatorType || 'author',
                      )
                    : c;
                  const displayName =
                    resolved.fullName ||
                    [resolved.firstName, resolved.lastName]
                      .filter(Boolean)
                      .join(' ') ||
                    entry.authors?.[cIdx] ||
                    '';
                  return {
                    name: displayName,
                    firstName: resolved.firstName,
                    lastName: resolved.lastName,
                    fullName: resolved.fullName || displayName,
                    ...(resolved.fieldMode !== undefined
                      ? { fieldMode: resolved.fieldMode }
                      : {}),
                    creatorType:
                      ('creatorType' in resolved
                        ? resolved.creatorType
                        : undefined) || 'author',
                  };
                })
              : Array.isArray(entry.authors)
                ? entry.authors.map((a: string, cIdx: number) => {
                    const parsedCreator = parseCreatorString(a, cIdx, 'author');
                    return {
                      name: a,
                      firstName: parsedCreator.firstName,
                      lastName: parsedCreator.lastName,
                      fullName: parsedCreator.fullName || a,
                      ...(parsedCreator.fieldMode !== undefined
                        ? { fieldMode: parsedCreator.fieldMode }
                        : {}),
                      creatorType: parsedCreator.creatorType || 'author',
                    };
                  })
                : [];

          const bibMeta = {
            ...(entry.pmid ? { pmid: entry.pmid } : {}),
            ...(entry.pmcid ? { pmcid: entry.pmcid } : {}),
            ...(entry.publicationTitle ? { publicationTitle: entry.publicationTitle } : {}),
            ...(entry.volume ? { volume: entry.volume } : {}),
            ...(entry.issue ? { issue: entry.issue } : {}),
            ...(entry.pages ? { pages: entry.pages } : {}),
            ...(Array.isArray(entry.keywords) && entry.keywords.length > 0 ? { keywords: entry.keywords } : {}),
            ...(entry.itemType ? { itemType: entry.itemType } : {}),
          };
          const serializedComments = Object.keys(bibMeta).length > 0 ? JSON.stringify(bibMeta) : undefined;

          const saved = await prismaClient.feedItem
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
                comments: serializedComments,
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
                ...(serializedComments ? { comments: serializedComments } : {}),
              },
            })
            .catch((err: unknown) => {
              this.logger.warn(`Failed to upsert feed item "${guid}": ${err instanceof Error ? err.message : String(err)}`);
              return null;
            });
          if (saved && typeof saved.id === 'string') {
            entry.id = saved.id;
            return saved;
          }
          return null;
        }),
      );
      for (const item of chunkRes) {
        if (item) persistedItems.push(item);
      }
    }
    return {
      id: feed.id,
      url: feed.url || feedUrl,
      title: feed.title || parsed.feedTitle || 'Academic Feed',
      items: persistedItems,
    };
  }

  mapCachedFeedToParsedFeed(cachedFeed: CachedFeedWithItems): ParsedAcademicFeed {
    return {
      format: 'atom',
      feedTitle: cachedFeed.title,
      feedUrl: cachedFeed.url,
      entries: (cachedFeed.items || []).map((it) => {
        let extraMeta: {
          pmid?: string;
          pmcid?: string;
          publicationTitle?: string;
          volume?: string;
          issue?: string;
          pages?: string;
          keywords?: string[];
          itemType?: string;
        } = {};
        const itComment = (it as { comments?: string | null }).comments;
        if (typeof itComment === 'string' && itComment.trim().startsWith('{')) {
          try {
            extraMeta = JSON.parse(itComment) as typeof extraMeta;
          } catch {
            extraMeta = {};
          }
        }
        type StoredAuthorRecord =
          | string
          | {
              name?: string;
              firstName?: string;
              lastName?: string;
              fullName?: string;
              fieldMode?: number;
              creatorType?: 'author' | 'editor' | 'translator' | 'contributor';
            };
        const rawAuthors = Array.isArray(it.authors)
          ? (it.authors as StoredAuthorRecord[])
          : [];
        const authors = rawAuthors
          .map((a) =>
            typeof a === 'string'
              ? a
              : a.name ||
                a.fullName ||
                [a.firstName, a.lastName].filter(Boolean).join(' ') ||
                '',
          )
          .filter(Boolean);
        const creators = rawAuthors
          .map((a, idx) => {
            if (typeof a === 'string') {
              return parseCreatorString(a, idx, 'author');
            }
            if (
              a.firstName ||
              a.fieldMode === 1 ||
              (a.lastName && !a.lastName.includes(' '))
            ) {
              const display =
                a.fullName ||
                a.name ||
                [a.firstName, a.lastName].filter(Boolean).join(' ');
              return {
                firstName: a.firstName || '',
                lastName: a.lastName || display,
                fullName: display,
                ...(a.fieldMode !== undefined ? { fieldMode: a.fieldMode } : {}),
                creatorType: a.creatorType || ('author' as const),
              };
            }
            const rawName = a.name || a.fullName || a.lastName || '';
            return parseCreatorString(rawName, idx, a.creatorType || 'author');
          })
          .filter((c) => Boolean(c.lastName || c.fullName));
        return {
          id: it.id,
          title: it.title,
          url: it.url,
          pdfUrl: it.pdfUrl || undefined,
          doi: it.doi || undefined,
          arxivId: it.arxivId || undefined,
          pmid: extraMeta.pmid || undefined,
          pmcid: extraMeta.pmcid || undefined,
          primaryCategory: it.primaryCategory || undefined,
          authors,
          creators,
          abstract: it.abstract || undefined,
          publicationTitle: extraMeta.publicationTitle || cachedFeed.title,
          volume: extraMeta.volume || undefined,
          issue: extraMeta.issue || undefined,
          pages: extraMeta.pages || undefined,
          publicationDate: it.publishedAt
            ? it.publishedAt.toISOString()
            : undefined,
          year: it.publishedAt
            ? new Date(it.publishedAt).getFullYear()
            : null,
          keywords:
            Array.isArray(extraMeta.keywords) && extraMeta.keywords.length > 0
              ? extraMeta.keywords
              : it.primaryCategory
                ? [it.primaryCategory]
                : [],
          rights: it.license || undefined,
          itemType:
            (extraMeta.itemType as 'preprint' | 'journalArticle') ||
            (it.arxivId ? 'preprint' : 'journalArticle'),
        };
      }),
    };
  }
}
