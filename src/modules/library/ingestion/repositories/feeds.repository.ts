import { Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService, isUuid } from '@/core';
import { parseCreatorString } from '@/modules/library/core';
import type { ParsedFeed } from '@/modules/library/ingestion/types/ingestion.types';

export interface FeedSubscriptionRecord {
  id: string; userId: string; feedId: string; customTitle: string | null;
  cleanupReadAfter: number; cleanupUnreadAfter: number;
  feed: {
    id: string; url: string; title: string;
    siteUrl: string | null; description: string | null; lastFetchedAt: Date | null;
  };
}

export interface CachedFeedWithItems {
  id: string; url: string; title: string; etag?: string | null;
  lastModified?: string | null; lastFetchedAt?: Date | null;
  items: Array<{
    id: string; title: string; url: string; pdfUrl?: string | null;
    doi?: string | null; arxivId?: string | null; primaryCategory?: string | null;
    authors?: unknown; abstract?: string | null; publishedAt?: Date | null;
    license?: string | null; guid?: string | null; comments?: string | null; metadata?: unknown;
  }>;
}

const FEED_SUMMARY_SELECT = {
  id: true, url: true, title: true, siteUrl: true, description: true, lastFetchedAt: true,
} as const;

type FeedItemExtraMeta = {
  pmid?: string; pmcid?: string; publicationTitle?: string; volume?: string;
  issue?: string; pages?: string; keywords?: string[]; itemType?: string;
};

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
      include: { feed: { select: FEED_SUMMARY_SELECT } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findFeedByUrl(url: string) {
    return this.prisma ? this.prisma.feed.findUnique({ where: { url } }) : null;
  }

  async findFeedWithRecentItemsByUrl(url: string, take = 50): Promise<CachedFeedWithItems | null> {
    if (!this.prisma) return null;
    return this.prisma.feed.findUnique({
      where: { url },
      include: { items: { orderBy: { publishedAt: 'desc' }, take } },
    });
  }

  async createFeed(data: { url: string; title: string; siteUrl?: string | null; description?: string | null }) {
    if (!this.prisma) throw new ServiceUnavailableException('Database is unavailable');
    return this.prisma.feed.create({ data });
  }

  async upsertSubscription(params: {
    userId: string; feedId: string; customTitle?: string;
    cleanupDays?: number; cleanupReadAfter?: number; cleanupUnreadAfter?: number;
  }): Promise<FeedSubscriptionRecord> {
    if (!this.prisma) throw new ServiceUnavailableException('Database is unavailable');
    const { userId, feedId, customTitle, cleanupDays } = params;
    const readDays = params.cleanupReadAfter !== undefined ? params.cleanupReadAfter : cleanupDays !== undefined ? cleanupDays : 7;
    const unreadDays = params.cleanupUnreadAfter !== undefined ? params.cleanupUnreadAfter : cleanupDays !== undefined ? cleanupDays : 30;
    return this.prisma.feedSubscription.upsert({
      where: { userId_feedId: { userId, feedId } },
      create: {
        userId, feedId, customTitle: customTitle || null,
        cleanupReadAfter: readDays, cleanupUnreadAfter: unreadDays,
      },
      update: {
        customTitle: customTitle || undefined,
        cleanupReadAfter: readDays, cleanupUnreadAfter: unreadDays,
      },
      include: { feed: { select: FEED_SUMMARY_SELECT } },
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
      where: { userId, OR: [{ feedId }, { id: feedId }] },
      include: { feed: { select: FEED_SUMMARY_SELECT } },
    });
  }

  async updateSubscriptionById(
    id: string,
    data: {
      customTitle?: string; cleanupDays?: number; cleanupReadAfter?: number;
      cleanupUnreadAfter?: number; feedId?: string;
    },
  ): Promise<FeedSubscriptionRecord> {
    if (!this.prisma) throw new ServiceUnavailableException('Database is unavailable');
    const nextReadAfter = data.cleanupReadAfter !== undefined ? data.cleanupReadAfter : data.cleanupDays;
    const nextUnreadAfter = data.cleanupUnreadAfter !== undefined ? data.cleanupUnreadAfter : data.cleanupDays;
    return this.prisma.feedSubscription.update({
      where: { id },
      data: {
        ...(data.customTitle !== undefined ? { customTitle: data.customTitle } : {}),
        ...(nextReadAfter !== undefined ? { cleanupReadAfter: nextReadAfter } : {}),
        ...(nextUnreadAfter !== undefined ? { cleanupUnreadAfter: nextUnreadAfter } : {}),
        ...(data.feedId ? { feedId: data.feedId } : {}),
      },
      include: { feed: { select: FEED_SUMMARY_SELECT } },
    });
  }

  private extractItemExtraMeta(it: { metadata?: unknown; comments?: string | null }): FeedItemExtraMeta {
    const rawMeta = it.metadata;
    if (rawMeta && typeof rawMeta === 'object' && !Array.isArray(rawMeta) && Object.keys(rawMeta as object).length > 0) {
      return rawMeta as FeedItemExtraMeta;
    }
    const itComment = it.comments;
    if (typeof itComment === 'string' && itComment.trim().startsWith('{')) {
      try {
        return JSON.parse(itComment) as FeedItemExtraMeta;
      } catch {
        return {};
      }
    }
    return {};
  }

  async findFeedItemsForUser(params: {
    userId: string; feedId: string; readStatus: 'read' | 'unread' | 'all'; limit: number;
    cursor?: string; page?: number; search?: string; cleanupReadAfter?: number; cleanupUnreadAfter?: number;
  }) {
    if (!this.prisma) return [];
    const { userId, feedId, readStatus, limit, cursor, page, search, cleanupReadAfter, cleanupUnreadAfter } = params;
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const readCutoff = cleanupReadAfter && cleanupReadAfter > 0 ? new Date(now - cleanupReadAfter * dayMs) : null;
    const unreadCutoff = cleanupUnreadAfter && cleanupUnreadAfter > 0 ? new Date(now - cleanupUnreadAfter * dayMs) : null;

    const retentionConditions: Prisma.FeedItemWhereInput[] = [];
    if (readCutoff) {
      retentionConditions.push({
        OR: [
          { readStates: { none: { userId, isRead: true } } },
          { readStates: { some: { userId, savedItemId: { not: null } } } },
          { readStates: { some: { userId, isRead: true, readAt: { gte: readCutoff } } } },
        ],
      });
    }
    if (unreadCutoff) {
      retentionConditions.push({
        OR: [
          { readStates: { some: { userId, isRead: true } } },
          { readStates: { some: { userId, savedItemId: { not: null } } } },
          { publishedAt: { gte: unreadCutoff } },
        ],
      });
    }

    const trimmedSearch = search?.trim();
    if (trimmedSearch) {
      retentionConditions.push({
        OR: [
          { title: { contains: trimmedSearch, mode: 'insensitive' } },
          { abstract: { contains: trimmedSearch, mode: 'insensitive' } },
          { doi: { contains: trimmedSearch, mode: 'insensitive' } },
          { arxivId: { contains: trimmedSearch, mode: 'insensitive' } },
          { primaryCategory: { contains: trimmedSearch, mode: 'insensitive' } },
        ],
      });
    }

    const validPage = page && page > 0 ? page : 1;
    const rawItems = await this.prisma.feedItem.findMany({
      where: {
        feedId,
        ...(readStatus === 'read'
          ? { readStates: { some: { userId, isRead: true } } }
          : readStatus === 'unread' ? { readStates: { none: { userId, isRead: true } } } : {}),
        ...(retentionConditions.length > 0 ? { AND: retentionConditions } : {}),
      },
      include: { readStates: { where: { userId }, select: { readAt: true, isRead: true, savedItemId: true } } },
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      take: limit,
      ...(cursor && isUuid(cursor)
        ? { cursor: { id: cursor }, skip: 1 }
        : validPage > 1 ? { skip: (validPage - 1) * limit } : {}),
    });

    const filteredRaw = !readCutoff && !unreadCutoff ? rawItems : rawItems.filter((item) => {
      const state = item.readStates?.[0] as { readAt?: Date | null; isRead?: boolean; savedItemId?: string | null } | undefined;
      if (state?.savedItemId) return true;
      const isRead = Boolean(state?.isRead ?? state?.readAt);
      const pubTime = item.publishedAt ? new Date(item.publishedAt) : null;
      if (isRead) {
        if (!readCutoff) return true;
        const referenceDate = state?.readAt ? new Date(state.readAt) : pubTime;
        return !referenceDate || referenceDate >= readCutoff;
      }
      return !unreadCutoff || !pubTime || pubTime >= unreadCutoff;
    });

    return filteredRaw.map((it) => {
      const state = it.readStates?.[0] as { readAt?: Date | null; isRead?: boolean; savedItemId?: string | null } | undefined;
      const extraMeta = this.extractItemExtraMeta(it);
      const cleanComments = typeof it.comments === 'string' && it.comments.trim().startsWith('{') ? null : it.comments;
      return {
        ...it,
        comments: cleanComments,
        metadata:
          it.metadata && typeof it.metadata === 'object' && !Array.isArray(it.metadata) && Object.keys(it.metadata as object).length > 0
            ? it.metadata
            : extraMeta,
        isRead: Boolean(state?.isRead ?? state?.readAt),
        readAt: state?.readAt ?? null,
        savedItemId: state?.savedItemId ?? null,
        isSaved: Boolean(state?.savedItemId),
      };
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
      const now = new Date();
      await this.prisma.feedItemReadState.upsert({
        where: { userId_itemId: { userId, itemId: resolvedId } },
        create: { userId, itemId: resolvedId, isRead: true, readAt: now },
        update: { isRead: true, readAt: now },
      });
    } else {
      const existing = await this.prisma.feedItemReadState.findUnique?.({
        where: { userId_itemId: { userId, itemId: resolvedId } },
        select: { savedItemId: true },
      });
      if (existing?.savedItemId && typeof this.prisma.feedItemReadState.update === 'function') {
        await this.prisma.feedItemReadState.update({
          where: { userId_itemId: { userId, itemId: resolvedId } },
          data: { isRead: false },
        });
      } else {
        await this.prisma.feedItemReadState.deleteMany({ where: { userId, itemId: resolvedId } });
      }
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
      where: { userId, itemId: { in: validIds }, isRead: true },
      select: { itemId: true },
    });
    return new Set(states.map((s) => s.itemId));
  }

  async findUserItemStates(
    userId: string,
    itemIds: string[],
  ): Promise<{ readIds: Set<string>; savedMap: Map<string, string> }> {
    const empty = { readIds: new Set<string>(), savedMap: new Map<string, string>() };
    if (!this.prisma?.feedItemReadState?.findMany || itemIds.length === 0) return empty;
    const validIds = itemIds.filter((id) => isUuid(id));
    if (validIds.length === 0) return empty;
    const states = await this.prisma.feedItemReadState.findMany({
      where: { userId, itemId: { in: validIds } },
      select: { itemId: true, isRead: true, savedItemId: true },
    });
    const readIds = new Set<string>();
    const savedMap = new Map<string, string>();
    for (const s of states) {
      if ((s as { isRead?: boolean }).isRead !== false) {
        readIds.add(s.itemId);
      }
      const savedId = (s as { savedItemId?: string | null }).savedItemId;
      if (typeof savedId === 'string' && savedId) {
        savedMap.set(s.itemId, savedId);
      }
    }
    return { readIds, savedMap };
  }

  async markManyItemsRead(userId: string, canonicalItemIds: string[]): Promise<void> {
    if (!this.prisma || canonicalItemIds.length === 0) return;
    const now = new Date();
    await this.prisma.feedItemReadState.createMany({
      data: canonicalItemIds.map((itemId) => ({ userId, itemId, isRead: true, readAt: now })),
      skipDuplicates: true,
    });
    if (typeof this.prisma.feedItemReadState.updateMany === 'function') {
      await this.prisma.feedItemReadState.updateMany({
        where: { userId, itemId: { in: canonicalItemIds }, isRead: false },
        data: { isRead: true, readAt: now },
      });
    }
  }

  async findActiveFeedsForPolling(take = 100) {
    if (!this.prisma) return [];
    const candidateWindow = Math.max(take * 5, 500);
    const feeds = await this.prisma.feed.findMany({
      where: { errorCount: { lt: 5 }, subscriptions: { some: {} } },
      orderBy: { lastFetchedAt: { sort: 'asc', nulls: 'first' } },
      select: { id: true, url: true, lastFetchedAt: true, refreshInterval: true },
      take: candidateWindow,
    });
    const now = Date.now();
    return feeds
      .filter((feed) => {
        if (!feed.lastFetchedAt) return true;
        const intervalSec = typeof feed.refreshInterval === 'number' && feed.refreshInterval > 0 ? feed.refreshInterval : 7200;
        return now - new Date(feed.lastFetchedAt).getTime() >= intervalSec * 1000;
      })
      .sort((a, b) => {
        if (!a.lastFetchedAt && b.lastFetchedAt) return -1;
        if (a.lastFetchedAt && !b.lastFetchedAt) return 1;
        if (!a.lastFetchedAt && !b.lastFetchedAt) return 0;
        const aInterval = typeof a.refreshInterval === 'number' && a.refreshInterval > 0 ? a.refreshInterval : 7200;
        const bInterval = typeof b.refreshInterval === 'number' && b.refreshInterval > 0 ? b.refreshInterval : 7200;
        return new Date(a.lastFetchedAt!).getTime() + aInterval * 1000 - (new Date(b.lastFetchedAt!).getTime() + bInterval * 1000);
      })
      .slice(0, take);
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
      select: { id: true, subscriptions: { select: { userId: true, cleanupReadAfter: true, cleanupUnreadAfter: true } } },
      take,
    });
  }

  async deleteFeedItemsOlderThan(
    cutoffDate: Date,
    feedId?: string,
    readStatus?: 'read' | 'unread',
    subscriberUserIds?: string[],
  ): Promise<number> {
    if (!this.prisma) return 0;
    const activeUserIds = Array.isArray(subscriberUserIds) ? subscriberUserIds.filter(Boolean) : [];
    let whereClause: Prisma.FeedItemWhereInput;
    if (readStatus === 'read') {
      const readFilter: Prisma.FeedItemWhereInput = activeUserIds.length > 0
        ? { AND: activeUserIds.map((uid) => ({ readStates: { some: { userId: uid, readAt: { lt: cutoffDate } } } })) }
        : { readStates: { some: { readAt: { lt: cutoffDate } } } };
      whereClause = { ...(feedId ? { feedId } : {}), readStates: { none: { savedItemId: { not: null } } }, ...readFilter };
    } else if (readStatus === 'unread') {
      const unreadFilter: Prisma.FeedItemWhereInput = activeUserIds.length > 0
        ? { OR: [{ readStates: { none: {} } }, ...activeUserIds.map((uid) => ({ readStates: { none: { userId: uid } } }))] }
        : { readStates: { none: {} } };
      whereClause = {
        ...(feedId ? { feedId } : {}),
        publishedAt: { lt: cutoffDate },
        readStates: { none: { savedItemId: { not: null } } },
        ...unreadFilter,
      };
    } else {
      whereClause = {
        ...(feedId ? { feedId } : {}),
        publishedAt: { lt: cutoffDate },
        ...(subscriberUserIds !== undefined ? { readStates: { none: { savedItemId: { not: null } } } } : {}),
      };
    }
    const res = await this.prisma.feedItem.deleteMany({ where: whereClause });
    return res.count;
  }

  async persistFetchedFeedAndItems(params: {
    feedUrl: string;
    parsed: ParsedFeed;
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
    const preparedEntries = boundedEntries
      .map((entry) => {
        const guid = (entry.doi || entry.arxivId || entry.url || entry.id || entry.title || '').trim();
        if (!guid || !entry.title) return null;
        const publishedDate = entry.publicationDate ? new Date(entry.publicationDate) : new Date();
        const validPublishedAt = isNaN(publishedDate.getTime()) ? new Date() : publishedDate;

        const authorsJson = Array.isArray(entry.creators) && entry.creators.length > 0
          ? entry.creators.map((c, cIdx) => {
              const needsReparse = !c.firstName && c.lastName && c.lastName.includes(' ') && c.fieldMode !== 1;
              const resolved = needsReparse ? parseCreatorString(c.lastName || '', cIdx, c.creatorType || 'author') : c;
              const displayName = resolved.fullName || [resolved.firstName, resolved.lastName].filter(Boolean).join(' ') || entry.authors?.[cIdx] || '';
              return {
                name: displayName,
                firstName: resolved.firstName,
                lastName: resolved.lastName,
                fullName: resolved.fullName || displayName,
                ...(resolved.fieldMode !== undefined ? { fieldMode: resolved.fieldMode } : {}),
                creatorType: ('creatorType' in resolved ? resolved.creatorType : undefined) || 'author',
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
                  ...(parsedCreator.fieldMode !== undefined ? { fieldMode: parsedCreator.fieldMode } : {}),
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
        const metadataJson: Prisma.InputJsonValue | undefined = Object.keys(bibMeta).length > 0 ? bibMeta : undefined;
        return { entry, guid, validPublishedAt, authorsJson, metadataJson };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null);

    if (preparedEntries.length === 0) {
      return { id: feed.id, url: feed.url || feedUrl, title: feed.title || parsed.feedTitle || 'Academic Feed', items: [] };
    }

    const entryGuids = Array.from(new Set(preparedEntries.map((p) => p.guid)));
    const persistedItems: CachedFeedWithItems['items'] = [];

    if (typeof prismaClient.feedItem.findMany === 'function' && typeof prismaClient.feedItem.createMany === 'function') {
      const existingRows = (await prismaClient.feedItem.findMany({ where: { feedId: feed.id, guid: { in: entryGuids } } })) ?? [];
      const existingByGuid = new Map(existingRows.map((r) => [r.guid, r]));
      const newItemsData: Prisma.FeedItemCreateManyInput[] = [];
      const seenNewGuids = new Set<string>();
      const updatesToRun: Array<Promise<unknown>> = [];

      for (const prep of preparedEntries) {
        const { entry, guid, validPublishedAt, authorsJson, metadataJson } = prep;
        const existing = existingByGuid.get(guid);
        if (!existing) {
          if (!seenNewGuids.has(guid)) {
            seenNewGuids.add(guid);
            newItemsData.push({
              feedId: feed.id, guid, title: entry.title, url: entry.url || feedUrl, pdfUrl: entry.pdfUrl,
              doi: entry.doi, arxivId: entry.arxivId, primaryCategory: entry.primaryCategory,
              authors: authorsJson, abstract: entry.abstract, license: entry.rights, comments: null,
              metadata: metadataJson ?? {}, publishedAt: validPublishedAt,
            });
          }
        } else {
          const nextUrl = entry.url || existing.url;
          const hasChanged =
            existing.title !== entry.title || existing.url !== nextUrl ||
            (existing.pdfUrl ?? null) !== (entry.pdfUrl ?? existing.pdfUrl ?? null) ||
            (existing.doi ?? null) !== (entry.doi ?? existing.doi ?? null) ||
            (existing.arxivId ?? null) !== (entry.arxivId ?? existing.arxivId ?? null) ||
            (existing.abstract ?? null) !== (entry.abstract ?? existing.abstract ?? null);

          if (hasChanged && typeof prismaClient.feedItem.update === 'function') {
            updatesToRun.push(
              prismaClient.feedItem
                .update({
                  where: { id: existing.id },
                  data: {
                    title: entry.title, url: entry.url || undefined, pdfUrl: entry.pdfUrl || undefined,
                    doi: entry.doi || undefined, arxivId: entry.arxivId || undefined,
                    primaryCategory: entry.primaryCategory || undefined, authors: authorsJson,
                    abstract: entry.abstract || undefined, license: entry.rights || undefined,
                    ...(metadataJson ? { metadata: metadataJson } : {}),
                  },
                })
                .then((updated) => { if (updated) existingByGuid.set(guid, updated); })
                .catch((err: unknown) => this.logger.warn(`Failed to update feed item "${guid}": ${err instanceof Error ? err.message : String(err)}`)),
            );
          }
        }
      }

      await Promise.all([
        ...(newItemsData.length > 0
          ? [
              prismaClient.feedItem
                .createMany({ data: newItemsData, skipDuplicates: true })
                .catch((err: unknown) => this.logger.warn(`Failed to createMany feed items: ${err instanceof Error ? err.message : String(err)}`)),
            ]
          : []),
        ...updatesToRun,
      ]);

      const finalRows = (await prismaClient.feedItem.findMany({ where: { feedId: feed.id, guid: { in: entryGuids } } })) ?? [];
      const finalByGuid = new Map(finalRows.map((r) => [r.guid, r]));
      for (const prep of preparedEntries) {
        const saved = finalByGuid.get(prep.guid) ?? existingByGuid.get(prep.guid);
        if (saved && typeof saved.id === 'string') {
          prep.entry.id = saved.id;
          persistedItems.push(saved);
        }
      }
    } else {
      const UPSERT_CHUNK_SIZE = 15;
      for (let i = 0; i < preparedEntries.length; i += UPSERT_CHUNK_SIZE) {
        const chunk = preparedEntries.slice(i, i + UPSERT_CHUNK_SIZE);
        const chunkRes = await Promise.all(
          chunk.map(async (prep) => {
            const { entry, guid, validPublishedAt, authorsJson, metadataJson } = prep;
            const saved = await prismaClient.feedItem
              .upsert({
                where: { feedId_guid: { feedId: feed.id, guid } },
                create: {
                  feedId: feed.id, guid, title: entry.title, url: entry.url || feedUrl, pdfUrl: entry.pdfUrl,
                  doi: entry.doi, arxivId: entry.arxivId, primaryCategory: entry.primaryCategory,
                  authors: authorsJson, abstract: entry.abstract, license: entry.rights, comments: null,
                  metadata: metadataJson ?? {}, publishedAt: validPublishedAt,
                },
                update: {
                  title: entry.title, url: entry.url || undefined, pdfUrl: entry.pdfUrl || undefined,
                  doi: entry.doi || undefined, arxivId: entry.arxivId || undefined,
                  primaryCategory: entry.primaryCategory || undefined, authors: authorsJson,
                  abstract: entry.abstract || undefined, license: entry.rights || undefined,
                  ...(metadataJson ? { metadata: metadataJson } : {}),
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
    }

    return {
      id: feed.id,
      url: feed.url || feedUrl,
      title: feed.title || parsed.feedTitle || 'Academic Feed',
      items: persistedItems,
    };
  }

  mapCachedFeedToParsedFeed(cachedFeed: CachedFeedWithItems): ParsedFeed {
    return {
      format: 'atom',
      feedTitle: cachedFeed.title,
      feedUrl: cachedFeed.url,
      entries: (cachedFeed.items || []).map((it) => {
        const extraMeta = this.extractItemExtraMeta(it);
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
        const rawAuthors = Array.isArray(it.authors) ? (it.authors as StoredAuthorRecord[]) : [];
        const authors = rawAuthors
          .map((a) => (typeof a === 'string' ? a : a.name || a.fullName || [a.firstName, a.lastName].filter(Boolean).join(' ') || ''))
          .filter(Boolean);
        const creators = rawAuthors
          .map((a, idx) => {
            if (typeof a === 'string') return parseCreatorString(a, idx, 'author');
            if (a.firstName || a.fieldMode === 1 || (a.lastName && !a.lastName.includes(' '))) {
              const display = a.fullName || a.name || [a.firstName, a.lastName].filter(Boolean).join(' ');
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
          publicationDate: it.publishedAt ? it.publishedAt.toISOString() : undefined,
          year: it.publishedAt ? new Date(it.publishedAt).getFullYear() : null,
          keywords: Array.isArray(extraMeta.keywords) && extraMeta.keywords.length > 0
            ? extraMeta.keywords
            : it.primaryCategory ? [it.primaryCategory] : [],
          rights: it.license || undefined,
          itemType: (extraMeta.itemType as 'preprint' | 'journalArticle') || (it.arxivId ? 'preprint' : 'journalArticle'),
        };
      }),
    };
  }
}
