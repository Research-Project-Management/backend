import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core';
import { Prisma, ReadStatus } from '@prisma/client';
import { normalizeProjectSpaceId } from '@/modules/library/core';
import { StateEntity, UpsertStateData } from '@/modules/library/catalog/types/catalog.types';
import { pickPreferredMergedState } from '@/modules/library/catalog/domain/state.domain';

const STATE_SELECT = {
  userId: true,
  itemId: true,
  isStarred: true,
  readStatus: true,
  rating: true,
  currentPage: true,
  scrollPosition: true,
  lastOpenedAt: true,
  lastReadAt: true,
  updatedAt: true,
} satisfies Prisma.LibraryItemStateSelect;

@Injectable()
export class StateRepository {
  constructor(private readonly prisma: PrismaService) {}

  private getClient(tx?: Prisma.TransactionClient) {
    return tx ?? this.prisma;
  }

  async findState(
    userId: string,
    itemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<StateEntity | null> {
    const client = this.getClient(tx);
    return client.libraryItemState.findUnique({
      where: {
        userId_itemId: {
          userId,
          itemId,
        },
      },
      select: STATE_SELECT,
    });
  }

  async findStatesForItems(
    userId: string,
    itemIds: string[],
    tx?: Prisma.TransactionClient,
    projectId?: string,
  ): Promise<StateEntity[]> {
    const client = this.getClient(tx);
    const validProjectId = normalizeProjectSpaceId(projectId);
    return client.libraryItemState.findMany({
      where: {
        userId,
        itemId: { in: itemIds },
        ...(validProjectId
          ? { item: { spaceId: validProjectId, deletedAt: null } }
          : {}),
      },
      select: STATE_SELECT,
    });
  }

  async upsertState(
    userId: string,
    itemId: string,
    data: UpsertStateData,
    tx?: Prisma.TransactionClient,
  ): Promise<StateEntity> {
    const client = this.getClient(tx);
    const dbReadStatus = data.readStatus
      ? (data.readStatus as unknown as ReadStatus)
      : undefined;

    const scrollJson =
      data.scrollPosition !== undefined
        ? data.scrollPosition !== null
          ? (data.scrollPosition as Prisma.InputJsonValue)
          : Prisma.JsonNull
        : undefined;

    const scrollObj =
      data.scrollPosition &&
      typeof data.scrollPosition === 'object' &&
      !Array.isArray(data.scrollPosition)
        ? data.scrollPosition
        : null;
    const resolvedAttachmentId =
      data.attachmentId?.trim() ||
      (typeof scrollObj?.attachmentId === 'string' &&
      scrollObj.attachmentId.trim()
        ? scrollObj.attachmentId.trim()
        : undefined);

    if (
      resolvedAttachmentId &&
      typeof client.attachmentReadingState?.upsert === 'function'
    ) {
      const currentPage =
        data.currentPage ??
        (typeof scrollObj?.page === 'number' ? scrollObj.page : undefined);
      const scrollOffsetX =
        typeof scrollObj?.scrollOffsetX === 'number'
          ? scrollObj.scrollOffsetX
          : typeof scrollObj?.left === 'number'
            ? scrollObj.left
            : undefined;
      const scrollOffsetY =
        typeof scrollObj?.scrollOffsetY === 'number'
          ? scrollObj.scrollOffsetY
          : typeof scrollObj?.top === 'number'
            ? scrollObj.top
            : undefined;
      const zoomScale =
        typeof scrollObj?.zoom === 'number'
          ? scrollObj.zoom
          : typeof scrollObj?.zoomScale === 'number'
            ? scrollObj.zoomScale
            : undefined;
      const rotation =
        typeof scrollObj?.rotation === 'number'
          ? scrollObj.rotation
          : undefined;
      const viewMode =
        typeof scrollObj?.viewMode === 'string'
          ? scrollObj.viewMode
          : typeof scrollObj?.fitMode === 'string'
            ? scrollObj.fitMode
            : undefined;

      const [upsertedState] = await Promise.all([
        client.libraryItemState.upsert({
          where: {
            userId_itemId: {
              userId,
              itemId,
            },
          },
          create: {
            userId,
            itemId,
            isStarred: data.isStarred ?? false,
            readStatus: dbReadStatus,
            rating: data.rating,
            currentPage: data.currentPage ?? 1,
            scrollPosition: scrollJson ?? Prisma.JsonNull,
            ...(resolvedAttachmentId
              ? { lastActiveAttachmentId: resolvedAttachmentId }
              : {}),
            lastOpenedAt: data.lastOpenedAt ?? new Date(),
            lastReadAt: data.lastReadAt,
          },
          update: {
            isStarred: data.isStarred,
            readStatus: dbReadStatus,
            rating: data.rating,
            currentPage: data.currentPage,
            scrollPosition: scrollJson,
            ...(resolvedAttachmentId
              ? { lastActiveAttachmentId: resolvedAttachmentId }
              : {}),
            lastOpenedAt: data.lastOpenedAt,
            lastReadAt: data.lastReadAt,
          },
          select: STATE_SELECT,
        }),
        client.attachmentReadingState.upsert({
          where: {
            userId_attachmentId: {
              userId,
              attachmentId: resolvedAttachmentId,
            },
          },
          create: {
            userId,
            attachmentId: resolvedAttachmentId,
            ...(currentPage !== undefined ? { currentPage } : {}),
            ...(scrollOffsetX !== undefined ? { scrollOffsetX } : {}),
            ...(scrollOffsetY !== undefined ? { scrollOffsetY } : {}),
            ...(zoomScale !== undefined ? { zoomScale } : {}),
            ...(rotation !== undefined ? { rotation } : {}),
            ...(viewMode !== undefined ? { viewMode } : {}),
          },
          update: {
            ...(currentPage !== undefined ? { currentPage } : {}),
            ...(scrollOffsetX !== undefined ? { scrollOffsetX } : {}),
            ...(scrollOffsetY !== undefined ? { scrollOffsetY } : {}),
            ...(zoomScale !== undefined ? { zoomScale } : {}),
            ...(rotation !== undefined ? { rotation } : {}),
            ...(viewMode !== undefined ? { viewMode } : {}),
            version: { increment: 1 },
          },
        }),
      ]);
      return upsertedState;
    }

    return client.libraryItemState.upsert({
      where: {
        userId_itemId: {
          userId,
          itemId,
        },
      },
      create: {
        userId,
        itemId,
        isStarred: data.isStarred ?? false,
        readStatus: dbReadStatus,
        rating: data.rating,
        currentPage: data.currentPage ?? 1,
        scrollPosition: scrollJson ?? Prisma.JsonNull,
        ...(resolvedAttachmentId
          ? { lastActiveAttachmentId: resolvedAttachmentId }
          : {}),
        lastOpenedAt: data.lastOpenedAt ?? new Date(),
        lastReadAt: data.lastReadAt,
      },
      update: {
        isStarred: data.isStarred,
        readStatus: dbReadStatus,
        rating: data.rating,
        currentPage: data.currentPage,
        scrollPosition: scrollJson,
        ...(resolvedAttachmentId
          ? { lastActiveAttachmentId: resolvedAttachmentId }
          : {}),
        lastOpenedAt: data.lastOpenedAt,
        lastReadAt: data.lastReadAt,
      },
      select: STATE_SELECT,
    });
  }

  async deleteState(
    userId: string,
    itemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<{ count: number }> {
    const client = this.getClient(tx);
    return client.libraryItemState.deleteMany({
      where: {
        userId,
        itemId,
      },
    });
  }

  async transferItemStates(
    sourceItemIds: string[],
    targetItemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    if (sourceItemIds.length === 0) return;
    const cleanSourceIds = sourceItemIds.filter((id) => id !== targetItemId);
    if (cleanSourceIds.length === 0) return;

    const client = this.getClient(tx);
    const allUserStates = await client.libraryItemState.findMany({
      where: { itemId: { in: [targetItemId, ...cleanSourceIds] } },
    });

    const userStateByUser = new Map<string, typeof allUserStates>();
    for (const us of allUserStates) {
      const list = userStateByUser.get(us.userId) || [];
      list.push(us);
      userStateByUser.set(us.userId, list);
    }

    const userStateEntries = Array.from(userStateByUser.entries()).sort(
      ([uidA], [uidB]) => (uidA < uidB ? -1 : uidA > uidB ? 1 : 0),
    );
    await Promise.all([
      ...userStateEntries.map(([userId, states]) => {
        const merged = pickPreferredMergedState(states);
        const targetState = states.find((s) => s.itemId === targetItemId) as
          { lastActiveAttachmentId?: string | null } | undefined;
        const bestSource = states.find(
          (s) =>
            s.itemId !== targetItemId &&
            Boolean(
              (s as { lastActiveAttachmentId?: string | null })
                .lastActiveAttachmentId,
            ),
        ) as { lastActiveAttachmentId?: string | null } | undefined;
        const lastActiveAttachmentId =
          targetState?.lastActiveAttachmentId ??
          bestSource?.lastActiveAttachmentId ??
          null;
        const scrollJson =
          merged.latestScroll !== undefined && merged.latestScroll !== null
            ? (merged.latestScroll as Prisma.InputJsonValue)
            : undefined;

        return client.libraryItemState.upsert({
          where: {
            userId_itemId: {
              userId,
              itemId: targetItemId,
            },
          },
          create: {
            userId,
            itemId: targetItemId,
            isStarred: merged.isStarred,
            rating: merged.maxRating,
            readStatus: merged.readStatus,
            currentPage: merged.maxCurrentPage,
            scrollPosition: scrollJson ?? Prisma.JsonNull,
            ...(lastActiveAttachmentId ? { lastActiveAttachmentId } : {}),
            lastOpenedAt: merged.latestOpenedAt,
            lastReadAt: merged.latestReadAt,
          },
          update: {
            isStarred: merged.isStarred,
            rating: merged.maxRating,
            readStatus: merged.readStatus,
            currentPage: merged.maxCurrentPage,
            scrollPosition: scrollJson,
            ...(lastActiveAttachmentId !== null
              ? { lastActiveAttachmentId }
              : {}),
            lastOpenedAt: merged.latestOpenedAt ?? undefined,
            lastReadAt: merged.latestReadAt ?? undefined,
          },
        });
      }),
      client.libraryItemState.deleteMany({
        where: { itemId: { in: cleanSourceIds } },
      }),
    ]);
  }
}
