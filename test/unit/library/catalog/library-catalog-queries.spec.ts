import { BadRequestException } from '@nestjs/common';
import { fromPartial } from '@total-typescript/shoehorn';
import { TagType } from '@prisma/client';
import { ItemQueryService } from '@/modules/library/catalog/services/item-query.service';
import { ItemFulltextService } from '@/modules/library/catalog/services/relations.service';
import { StateService } from '@/modules/library/catalog/services/state.service';
import { NotesService } from '@/modules/library/catalog/services/notes.service';
import { TagsService } from '@/modules/library/catalog/services/tags.service';
import { QueryRepository } from '@/modules/library/catalog/repositories/query.repository';
import { StateRepository } from '@/modules/library/catalog/repositories/state.repository';
import { NotesRepository } from '@/modules/library/catalog/repositories/notes.repository';
import { TagsRepository } from '@/modules/library/catalog/repositories/tags.repository';
import { ReadingStatus } from '@/modules/library/catalog/types/catalog.types';
import {
  formatStateDate,
  isValidRating,
  isValidCurrentPage,
  isValidScrollPosition,
  shouldAutoAdvanceToReading,
  isValidStateTransition,
  pickPreferredMergedState,
  mergeScrollPosition,
  toStateResponse,
} from '@/modules/library/catalog/domain/state.domain';
import { formatLiteratureNoteMarkdown } from '@/modules/library/catalog/domain/notes.domain';
import { PrismaService, RedisCacheService } from '@/core';
import {
  LIBRARY_REDIS_KEYS,
  buildTipTapDocFromText,
} from '@/modules/library/core';

describe('Library Catalog Queries — Filtering, Cache-Aside, Reading State, Notes & Tags', () => {
  const mockUserId = '11111111-1111-4111-8111-111111111111';
  const mockProjectId = '22222222-2222-4222-8222-222222222222';
  const mockItemId = '33333333-3333-4333-8333-333333333333';

  describe('ItemQueryService & ItemFulltextService Cache-Aside', () => {
    const dbItem = {
      id: mockItemId,
      userId: mockUserId,
      title: 'Attention Is All You Need',
      itemType: 'journalArticle',
      version: 1,
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      contributors: [],
      collectionItems: [],
      itemTags: [],
      notes: [],
      attachments: [],
    };

    let queryRepo: jest.Mocked<QueryRepository>;
    let cache: jest.Mocked<RedisCacheService>;
    let queryService: ItemQueryService;
    let fulltextService: ItemFulltextService;

    beforeEach(() => {
      queryRepo = fromPartial({
        findById: jest.fn().mockResolvedValue(dbItem),
        findMany: jest.fn().mockResolvedValue([dbItem]),
        count: jest.fn().mockResolvedValue(1),
        countByItemType: jest.fn().mockResolvedValue({ journalArticle: 1 }),
        findItemMetadataByProviders: jest.fn().mockResolvedValue({
          id: 'meta-1',
          sourceProvider: 'pdf_fulltext',
          rawPayload: {
            title: 'Attention Is All You Need',
            abstract: 'We propose the Transformer...',
            sections: [{ title: 'Introduction', text: 'Recurrent models...' }],
          },
        }),
      });

      cache = fromPartial({
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue(undefined),
      });

      queryService = new ItemQueryService(queryRepo, cache);
      fulltextService = new ItemFulltextService(queryRepo, cache);
    });

    it('populates item cache on miss, serves from cache on hit, and rejects cross-tenant cached items', async () => {
      const missResult = await queryService.getItem(mockUserId, mockItemId);
      expect(missResult?.title).toBe('Attention Is All You Need');
      expect(cache.set).toHaveBeenCalledWith(
        LIBRARY_REDIS_KEYS.item(mockItemId),
        expect.objectContaining({ id: mockItemId }),
        300,
      );

      queryRepo.findById.mockClear();
      cache.get.mockResolvedValueOnce({
        id: mockItemId,
        userId: mockUserId,
        title: 'Cached Title',
        itemType: 'journalArticle',
      });
      const hitResult = await queryService.getItem(mockUserId, mockItemId);
      expect(hitResult?.title).toBe('Cached Title');
      expect(queryRepo.findById).not.toHaveBeenCalled();

      cache.get.mockResolvedValueOnce({
        id: mockItemId,
        userId: 'other-user-9999',
        projectId: null,
        title: 'Foreign Tenant Item',
      });
      await queryService.getItem(mockUserId, mockItemId);
      expect(queryRepo.findById).toHaveBeenCalledWith(
        mockUserId,
        mockItemId,
        undefined,
      );
    });

    it('caches clean list queries, bypasses cache for search queries, and survives Redis errors', async () => {
      const listed = await queryService.listItems(mockUserId, {
        view: 'all',
        limit: 20,
      });
      expect(listed.items).toHaveLength(1);
      expect(cache.set).toHaveBeenCalled();

      cache.get.mockClear();
      cache.set.mockClear();
      await queryService.listItems(mockUserId, {
        search: 'quantum',
        limit: 20,
      });
      expect(cache.get).not.toHaveBeenCalled();

      cache.get.mockRejectedValueOnce(new Error('Redis offline'));
      const fallbackItem = await queryService.getItem(mockUserId, mockItemId);
      expect(fallbackItem?.id).toBe(mockItemId);

      const fulltext = await fulltextService.getFulltext(
        mockUserId,
        mockItemId,
      );
      expect(fulltext.sections).toHaveLength(1);
    });

    it('coalesces concurrent getCounts calls via single-flight', async () => {
      const slowCountByType = jest.fn(
        () =>
          new Promise<Record<string, number>>((resolve) =>
            setTimeout(() => resolve({ journalArticle: 4 }), 1),
          ),
      );
      const svc = new ItemQueryService(
        fromPartial({
          count: jest.fn().mockResolvedValue(0),
          countByItemType: slowCountByType,
          getProjectMemberRole: jest.fn().mockResolvedValue('owner'),
        }),
      );

      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          svc.getCounts(mockUserId, mockProjectId),
        ),
      );
      expect(slowCountByType).toHaveBeenCalledTimes(1);
      expect(results[0].total).toBe(4);
    });
  });

  describe('QueryRepository Filtering & Sort Whitelisting', () => {
    const itemMock = {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
    };
    const queryRepo = new QueryRepository({
      item: itemMock,
      libraryItem: itemMock,
    } as unknown as PrismaService);

    beforeEach(() => {
      itemMock.findMany.mockClear();
    });

    it('builds grounded where clauses for personal/project scope, unread missing-state rows, multi-select types, year range, my-publications, and everything search', () => {
      expect(queryRepo.buildWhereClause(mockUserId, { view: 'all' })).toEqual(
        expect.objectContaining({ spaceId: mockUserId, deletedAt: null }),
      );
      expect(
        queryRepo.buildWhereClause(mockUserId, {
          view: 'all',
          projectId: mockProjectId,
        }),
      ).toEqual(
        expect.objectContaining({ spaceId: mockProjectId, deletedAt: null }),
      );

      const unreadWhere = queryRepo.buildWhereClause(mockUserId, {
        readStatus: 'unread,reading',
        type: 'journalArticle,preprint',
        fromYear: 2022,
        toYear: 2026,
        hasFile: true,
      }) as Record<string, unknown>;
      expect(unreadWhere.itemType).toEqual({
        in: ['journalArticle', 'preprint'],
      });
      expect(unreadWhere.year).toEqual({ gte: 2022, lte: 2026 });
      expect(unreadWhere.hasFile).toBe(true);
      expect(unreadWhere.AND).toContainEqual({
        OR: [
          { states: { none: { userId: mockUserId } } },
          {
            states: {
              some: {
                userId: mockUserId,
                readStatus: { in: ['unread', 'reading'] },
              },
            },
          },
        ],
      });

      const myPubSearch = queryRepo.buildWhereClause(mockUserId, {
        view: 'my-publications',
        search: 'quantum computing',
      }) as { AND: Array<{ OR: unknown[] }> };
      expect(myPubSearch.AND).toHaveLength(2);
      expect(myPubSearch.AND[0].OR).toContainEqual({
        publications: { some: { userId: mockUserId } },
      });
      expect(myPubSearch.AND[1].OR).toContainEqual({
        title: { contains: 'quantum computing', mode: 'insensitive' },
      });

      const everythingWhere = queryRepo.buildWhereClause(mockUserId, {
        search: 'attention',
        searchMode: 'everything',
      }) as { AND: Array<{ OR: unknown[] }> };
      expect(JSON.stringify(everythingWhere.AND[0].OR)).toContain(
        'fullTextIndexes',
      );
      expect(JSON.stringify(everythingWhere.AND[0].OR)).toContain('quoteText');
    });

    it('maps sort aliases (authors -> firstAuthor, publication -> publicationTitle)', async () => {
      await queryRepo.findMany(mockUserId, {
        orderBy: 'authors',
        orderDirection: 'asc',
      });
      expect(itemMock.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [
            { firstAuthor: { sort: 'asc', nulls: 'last' } },
            { id: 'asc' },
          ],
        }),
      );

      await queryRepo.findMany(mockUserId, {
        orderBy: 'publication',
        orderDirection: 'desc',
      });
      expect(itemMock.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          orderBy: [
            { publicationTitle: { sort: 'desc', nulls: 'last' } },
            { id: 'desc' },
          ],
        }),
      );
    });
  });

  describe('StateService & Reading Progress Domain', () => {
    it('validates dates, ratings, pages, 16KB scroll cap, auto-advance, and monotonic state/scroll merging', () => {
      const iso = '2026-09-19T10:00:00.000Z';
      expect(formatStateDate(new Date(iso))).toBe(iso);
      expect(formatStateDate(iso)).toBe(iso);
      expect(formatStateDate('invalid-date')).toBeNull();

      expect(isValidRating(5)).toBe(true);
      expect(isValidRating(-1)).toBe(false);
      expect(isValidRating(3.5)).toBe(false);

      expect(isValidCurrentPage(1)).toBe(true);
      expect(isValidCurrentPage(0)).toBe(false);

      expect(isValidScrollPosition({ page: 1, top: 120 })).toBe(true);
      expect(isValidScrollPosition('primitive')).toBe(false);
      expect(isValidScrollPosition({ data: 'x'.repeat(20_000) })).toBe(false);

      expect(shouldAutoAdvanceToReading(ReadingStatus.UNREAD, 2, null)).toBe(
        true,
      );
      expect(shouldAutoAdvanceToReading(ReadingStatus.UNREAD, 1, null)).toBe(
        false,
      );
      expect(
        isValidStateTransition(ReadingStatus.UNREAD, ReadingStatus.READING),
      ).toBe(true);

      const merged = pickPreferredMergedState([
        {
          userId: 'u1',
          itemId: 'i1',
          readStatus: 'unread',
          isStarred: false,
          currentPage: 2,
          rating: 3,
        },
        {
          userId: 'u1',
          itemId: 'i2',
          readStatus: 'reading',
          isStarred: true,
          currentPage: 14,
          rating: 5,
        },
      ]);
      expect(merged.readStatus).toBe('reading');
      expect(merged.isStarred).toBe(true);
      expect(merged.maxCurrentPage).toBe(14);
      expect(merged.maxRating).toBe(5);

      const mergedScroll = mergeScrollPosition(
        { page: 4, scrollTop: 120, progress: 25 },
        { page: 9, scrollTop: 340, progress: 60 },
        'att-pdf-1',
      ) as Record<string, unknown>;
      expect(mergedScroll.page).toBe(9);
      expect(mergedScroll.byAttachment).toBeDefined();

      const normalized = toStateResponse({
        readStatus: 'reading',
        rating: 4,
        currentPage: 15,
        scrollPosition: { top: 300 },
        lastOpenedAt: iso as unknown as Date,
        lastReadAt: iso as unknown as Date,
      });
      expect(normalized.readStatus).toBe(ReadingStatus.READING);
      expect(normalized.lastOpenedAt).toBe(iso);
    });

    it('updates reading state, emits project-scoped outbox events, and merges states across duplicate items safely', async () => {
      const helpers = {
        appendChange: jest.fn().mockResolvedValue({}),
        recordTombstone: jest.fn().mockResolvedValue({}),
        publishOutbox: jest.fn().mockResolvedValue({}),
      };
      const txMock = {
        executeInTransaction: jest.fn(
          (cb: (tx: unknown, h: typeof helpers) => unknown) => cb({}, helpers),
        ),
      };
      const repoMock = fromPartial<jest.Mocked<StateRepository>>({
        findState: jest.fn().mockResolvedValue({
          readStatus: 'unread',
          rating: 0,
          currentPage: 1,
        }),
        findStatesForItems: jest.fn().mockResolvedValue([
          {
            id: 'st-1',
            userId: mockUserId,
            itemId: 'item-1',
            readStatus: 'reading',
            rating: 4,
            currentPage: 8,
            scrollPosition: null,
            lastOpenedAt: new Date(),
            lastReadAt: new Date(),
            updatedAt: new Date(),
          },
        ]),
        upsertState: jest.fn().mockResolvedValue({
          id: 'st-1',
          userId: mockUserId,
          itemId: mockItemId,
          readStatus: 'reading',
          rating: 3,
          currentPage: 4,
          scrollPosition: null,
          lastOpenedAt: new Date(),
          lastReadAt: new Date(),
          updatedAt: new Date(),
        }),
        transferItemStates: jest.fn(
          (sourceItemIds: string[], targetItemId: string, tx?: never) =>
            new StateRepository({} as never).transferItemStates(
              sourceItemIds,
              targetItemId,
              tx,
            ),
        ),
      });

      const service = new StateService(
        repoMock,
        txMock as never,
        fromPartial<ItemQueryService>({
          assertExists: jest.fn().mockResolvedValue(undefined),
        }),
      );

      await expect(
        service.updateState(mockUserId, mockItemId, { rating: 7 }),
      ).rejects.toThrow(BadRequestException);

      const updated = await service.updateState(
        mockUserId,
        mockItemId,
        { currentPage: 4, rating: 3 },
        mockProjectId,
      );
      expect(updated.readStatus).toBe(ReadingStatus.READING);
      expect(helpers.publishOutbox).toHaveBeenCalledWith(
        { userId: mockUserId, projectId: mockProjectId },
        mockItemId,
        'library.reading.updated',
        expect.objectContaining({
          projectId: mockProjectId,
          readStatus: 'reading',
        }),
      );

      const batch = await service.getBatchStates(mockUserId, [
        'item-1',
        'item-2',
      ]);
      expect(batch['item-1'].readStatus).toBe(ReadingStatus.READING);
      expect(batch['item-2'].readStatus).toBe(ReadingStatus.UNREAD);

      const statePrismaMock = {
        findMany: jest.fn().mockResolvedValue([
          {
            userId: mockUserId,
            itemId: 'item-dup-1',
            isStarred: true,
            rating: 4,
            readStatus: 'reading',
            currentPage: 10,
            scrollPosition: {
              page: 10,
              byAttachment: { 'att-1': { page: 10 } },
            },
            lastOpenedAt: new Date('2026-09-10'),
            lastReadAt: new Date('2026-09-10'),
          },
          {
            userId: mockUserId,
            itemId: 'item-target',
            isStarred: false,
            rating: 5,
            readStatus: 'completed',
            currentPage: 25,
            scrollPosition: {
              page: 25,
              byAttachment: { 'att-2': { page: 25 } },
            },
            lastOpenedAt: new Date('2026-09-15'),
            lastReadAt: new Date('2026-09-15'),
          },
        ]),
        upsert: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      };

      await service.transferUserItemStates(
        {
          state: statePrismaMock,
          libraryItemState: statePrismaMock,
        } as never,
        ['item-dup-1', 'item-target'],
        'item-target',
      );
      expect(statePrismaMock.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            isStarred: true,
            rating: 5,
            readStatus: 'completed',
            currentPage: 25,
            scrollPosition: expect.objectContaining({
              byAttachment: {
                'att-1': { page: 10 },
                'att-2': { page: 25 },
              },
            }),
          }),
        }),
      );
      expect(statePrismaMock.deleteMany).toHaveBeenCalledWith({
        where: { itemId: { in: ['item-dup-1'] } },
      });
    });
  });

  describe('Notes & Tags Multi-Protocol Formatting and Project Scoping', () => {
    it('formats literature note backlinks across flux://, zotero://, and https:// protocols and syncs TipTap contentMd', async () => {
      const mockItem = {
        id: 'paper-123',
        title: 'Attention Is All You Need',
        year: 2017,
        citekey: 'vaswani2017',
        creators: [{ lastName: 'Vaswani', fullName: 'Ashish Vaswani' }],
      };
      const mockAnnotations = [
        {
          id: 'ann-999',
          attachmentId: 'att-456',
          pageIndex: 0,
          color: '#ff6666',
          quoteText: 'The Transformer is the first transduction model.',
          comment: 'Groundbreaking finding',
        },
      ];

      expect(formatLiteratureNoteMarkdown(mockItem, mockAnnotations)).toContain(
        'flux://open-pdf/library/papers/paper-123?attachmentId=att-456&page=1&annotation=ann-999',
      );
      expect(
        formatLiteratureNoteMarkdown(mockItem, mockAnnotations, {
          protocol: 'zotero',
        }),
      ).toContain('zotero://open-pdf/0_att-456/1?annotation=ann-999');
      expect(
        formatLiteratureNoteMarkdown(mockItem, mockAnnotations, {
          protocol: 'web',
          webBaseUrl: 'https://research.flux.ac',
        }),
      ).toContain(
        'https://research.flux.ac/library/papers/paper-123?attachmentId=att-456&page=1&annotation=ann-999',
      );

      const noteMock = {
        findFirst: jest.fn().mockResolvedValue({
          id: 'note-1',
          userId: mockUserId,
          projectId: null,
          title: 'Old Title',
          contentMd: 'Stale old markdown',
          contentJson: { type: 'doc', content: [] },
          tags: [],
          version: 1,
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      };
      const notesRepo = new NotesRepository({
        note: noteMock,
        libraryNote: noteMock,
      } as unknown as PrismaService);

      const updated = await notesRepo.update(mockUserId, 'note-1', 1, {
        contentJson: buildTipTapDocFromText('Updated A.\n\nUpdated B.'),
      });
      expect(updated.contentMd).toBe('Updated A.\n\nUpdated B.');
    });

    it('propagates projectId to changelog, tombstones, and outbox in NotesService and TagsService', async () => {
      const helpers = {
        appendChange: jest.fn().mockResolvedValue({}),
        recordTombstone: jest.fn().mockResolvedValue({}),
        publishOutbox: jest.fn().mockResolvedValue({}),
      };
      const txMock = {
        executeInTransaction: jest.fn(
          (cb: (tx: unknown, h: typeof helpers) => unknown) =>
            cb(
              {
                tag: { findFirst: jest.fn().mockResolvedValue({ id: 'tag-1' }) },
                libraryTag: {
                  findFirst: jest.fn().mockResolvedValue({ id: 'tag-1' }),
                },
                item: {
                  findFirst: jest.fn().mockResolvedValue({ id: mockItemId }),
                },
                libraryItem: {
                  findFirst: jest.fn().mockResolvedValue({ id: mockItemId }),
                },
              },
              helpers,
            ),
        ),
      };

      const notesRepo = fromPartial<jest.Mocked<NotesRepository>>({
        create: jest.fn().mockResolvedValue({
          id: 'note-1',
          version: 1,
          title: 'Project Note',
          spaceId: mockProjectId,
        }),
        findById: jest
          .fn()
          .mockResolvedValue({ id: 'note-1', spaceId: mockProjectId }),
        softDelete: jest.fn().mockResolvedValue(true),
      });

      const notesService = new NotesService(
        notesRepo,
        txMock as never,
        fromPartial<ItemQueryService>({
          exists: jest.fn().mockResolvedValue(true),
        }),
      );

      await notesService.createNote(mockUserId, {
        title: 'Project Note',
        projectId: mockProjectId,
        itemId: mockItemId,
        createdById: mockUserId,
      });
      expect(helpers.appendChange).toHaveBeenCalledWith(
        { userId: mockUserId, projectId: mockProjectId },
        expect.objectContaining({ entityType: 'Note', action: 'create' }),
      );

      await notesService.deleteNote(mockUserId, 'note-1', 1, mockProjectId);
      expect(helpers.recordTombstone).toHaveBeenCalledWith(
        { userId: mockUserId, projectId: mockProjectId },
        expect.objectContaining({ entityType: 'Note', entityId: 'note-1' }),
      );

      const tagsService = new TagsService(
        fromPartial<TagsRepository>({
          create: jest.fn().mockResolvedValue({
            id: 'tag-1',
            name: 'physics',
            spaceId: mockProjectId,
          }),
          assignToItem: jest.fn().mockResolvedValue(undefined),
          removeFromItem: jest.fn().mockResolvedValue(undefined),
        }),
        txMock as never,
      );
      jest
        .spyOn(tagsService, 'invalidateTagsCache')
        .mockResolvedValue(undefined);

      await tagsService.createOrGetTag(
        mockUserId,
        'physics',
        '#00ff00',
        TagType.manual,
        mockProjectId,
      );
      await tagsService.assignTag(
        mockUserId,
        'tag-1',
        mockItemId,
        mockProjectId,
      );
      await tagsService.removeTag(
        mockUserId,
        'tag-1',
        mockItemId,
        mockProjectId,
      );

      expect(helpers.appendChange).toHaveBeenCalledWith(
        { userId: mockUserId, projectId: mockProjectId },
        expect.objectContaining({
          entityType: 'ItemTag',
          entityId: `tag-1:${mockItemId}`,
        }),
      );
      expect(helpers.recordTombstone).toHaveBeenCalledWith(
        { userId: mockUserId, projectId: mockProjectId },
        expect.objectContaining({
          entityType: 'ItemTag',
          entityId: `tag-1:${mockItemId}`,
        }),
      );
    });
  });
});
