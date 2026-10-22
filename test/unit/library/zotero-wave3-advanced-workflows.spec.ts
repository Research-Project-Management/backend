import { SearchService } from '@/modules/library/search/services/search.service';
import { SearchRepository } from '@/modules/library/search/repositories/search.repository';
import { FullTextProvider } from '@/modules/library/search/services/full-text.provider';
import {
  ScopeSpecification,
  SearchSpecificationBuilder,
  TextSearchSpecification,
  sanitizeSearchQuery,
} from '@/modules/library/search';
import { SyncController } from '@/modules/library/sync/controllers/sync.controller';
import { ChangeLogRepository } from '@/modules/library/sync/repositories/changelog.repository';
import { TransactionService } from '@/modules/library/sync/services/transaction.service';
import { compactLibraryChanges } from '@/modules/library/sync/domain/outbox.domain';
import { NotesService } from '@/modules/library/catalog/services/notes.service';
import { NotesRepository } from '@/modules/library/catalog/repositories/notes.repository';
import { ItemService } from '@/modules/library/catalog/services/items.service';
import { CommandRepository } from '@/modules/library/catalog/repositories/command.repository';
import { QueryRepository } from '@/modules/library/catalog/repositories/query.repository';
import { VersionMismatchException } from '@/modules/library/core/errors/version-mismatch.exception';
import { LayoutHeuristicExtractor } from '@/modules/library/extraction/extractors/layout-heuristic.extractor';
import { ScientificChunkingService } from '@/modules/ai/ingestion/services/scientific-chunking.service';
import { ReferenceMatcherService } from '@/modules/library/extraction/services/reference-matcher.service';
import { ExtractionRepository } from '@/modules/library/extraction/repositories/extraction.repository';
import { ExtractionHandler } from '@/modules/library/extraction/services/extraction.handler';
import { ExportsService } from '@/modules/library/citation/services/exports.service';
import {
  ExportsRepository,
  ExportItemRecord,
} from '@/modules/library/citation/repositories/exports.repository';
import { CitationService } from '@/modules/library/citation/services/citation.service';
import { CslEngineService } from '@/modules/library/citation/services/csl-engine.service';
import { PdfBakerService } from '@/modules/library/citation/services/pdf-baker.service';
import { CitationFacade } from '@/modules/library/citation/citation.facade';
import { LibraryFacade } from '@/modules/library/library.facade';
import { CatalogFacade } from '@/modules/library/catalog/catalog.facade';
import { NotFoundException } from '@nestjs/common';

describe('Wave 3: Advanced Zotero 7 Workflows — Search & Facets, Sync & OCC, 2-Column PDF & Reference Graph, LaTeX Citation Integration', () => {
  // USER STORY 1: Zotero Advanced Search, Full-Text PDF Page Anchors & Facets
  describe('User Story 1: Zotero Advanced Search, Full-Text PDF Page Anchors & Faceted Filtering', () => {
    it('handles special regex/SQL characters (% _ \\ \' ") and empty queries cleanly without breaking SQL or throwing', async () => {
      const findManyMock = jest.fn().mockResolvedValue([
        {
          id: 'item-special-1',
          title: '100% Accuracy_Rate in C:\\Temp "Quoted" & \'Single\' Study',
          year: 2025,
          itemType: 'journalArticle',
          userId: 'user-1',
          projectId: null,
          deletedAt: null,
          contributors: [],
          attachments: [],
          itemTags: [{ tag: { name: 'robustness' } }],
          collectionItems: [],
        },
      ]);
      const queryRawUnsafeMock = jest.fn();
      const groupByMock = jest
        .fn()
        .mockResolvedValueOnce([
          { itemType: 'journalArticle', _count: { _all: 1 } },
        ])
        .mockResolvedValueOnce([{ year: 2025, _count: { _all: 1 } }]);
      const itemTagFindManyMock = jest
        .fn()
        .mockResolvedValue([{ tag: { name: 'robustness' } }]);

      const mockPrisma = {
        $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
        $queryRawUnsafe: queryRawUnsafeMock,
        item: {
          findMany: findManyMock,
          groupBy: groupByMock,
        },
        itemTag: {
          findMany: itemTagFindManyMock,
        },
      };

      const searchRepo = new SearchRepository(
        mockPrisma as unknown as ConstructorParameters<
          typeof SearchRepository
        >[0],
      );
      await searchRepo.onModuleInit();

      const fullTextProvider = new FullTextProvider(searchRepo);
      const searchService = new SearchService(searchRepo, fullTextProvider);

      // 1. Query containing only punctuation/SQL special chars "% _ \ ' ""
      // sanitizeSearchQuery strips pure syntax characters to empty string, so SearchRepository
      // must bypass raw tsquery and fall back to parameterized Prisma ILIKE without throwing.
      expect(sanitizeSearchQuery(`'"\\*()&|!`)).toBe('');
      const specialOnlyRes = await searchService.search('user-1', {
        query: `'"\\*()&|!`,
        itemType: 'journalArticle',
        yearFrom: 2020,
        yearTo: 2026,
        sortBy: 'year',
        sortOrder: 'desc',
      });

      expect(queryRawUnsafeMock).not.toHaveBeenCalled();
      expect(findManyMock).toHaveBeenCalledTimes(1);
      expect(specialOnlyRes.items).toHaveLength(1);
      expect(specialOnlyRes.facets.itemTypes).toEqual({ journalArticle: 1 });
      expect(specialOnlyRes.facets.years).toEqual({ 2025: 1 });
      expect(specialOnlyRes.facets.tags).toEqual({ robustness: 1 });

      // 2. Empty / whitespace query for facet browsing with sortBy: 'createdAt'
      const emptyQueryRes = await searchService.search('user-1', {
        query: '   ',
        sortBy: 'createdAt',
        sortOrder: 'asc',
      });
      expect(emptyQueryRes.items).toHaveLength(1);
      expect(findManyMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: {
            AND: [{ userId: 'user-1', projectId: null }, { deletedAt: null }],
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'desc' }],
        }),
      );

      // 3. TextSearchSpecification in-memory & Prisma criteria with SQL wildcards (% and _)
      const spec = new TextSearchSpecification('100% accuracy_rate');
      expect(
        spec.isSatisfiedBy({
          title: 'Achieving 100% Accuracy_Rate in Neural Networks',
        }),
      ).toBe(true);
      const prismaWhere = spec.toPrismaWhere();
      expect(prismaWhere).toHaveProperty('OR');
    });

    it('strictly isolates personal scope (projectId: null | "user" | "personal") vs project scope in SearchSpecificationBuilder and SearchRepository', async () => {
      const personalSpec = SearchSpecificationBuilder.fromOptions('user-1', {
        projectId: 'personal',
        itemType: 'conferencePaper',
        yearFrom: 2022,
        yearTo: 2025,
        collectionId: 'col-1',
        tagId: 'tag-1',
      });

      expect(
        personalSpec.isSatisfiedBy({
          userId: 'user-1',
          projectId: null,
          deletedAt: null,
          itemType: 'conferencePaper',
          year: 2024,
          collectionItems: [{ collectionId: 'col-1' }],
          itemTags: [{ tagId: 'tag-1' }],
        }),
      ).toBe(true);

      // Project item must NOT satisfy personal scope specification
      expect(
        personalSpec.isSatisfiedBy({
          userId: 'user-1',
          projectId: 'proj-999',
          deletedAt: null,
          itemType: 'conferencePaper',
          year: 2024,
          collectionItems: [{ collectionId: 'col-1' }],
          itemTags: [{ tagId: 'tag-1' }],
        }),
      ).toBe(false);

      // Project scope specification must only match items in that project
      const projectScopeSpec = new ScopeSpecification('user-1', 'proj-999');
      expect(projectScopeSpec.toPrismaWhere()).toEqual({
        projectId: 'proj-999',
      });
      expect(
        projectScopeSpec.isSatisfiedBy({
          userId: 'other-user',
          projectId: 'proj-999',
        }),
      ).toBe(true);
      expect(
        projectScopeSpec.isSatisfiedBy({
          userId: 'user-1',
          projectId: null,
        }),
      ).toBe(false);
    });

    it('SearchService.searchPageAnchors and rebuildIndex return clean contextual PDF page snippets and enforce scope security', async () => {
      const mockPrisma = {
        attachment: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'att-pdf-1',
            item: {
              id: 'item-1',
              userId: 'user-1',
              projectId: null,
            },
          }),
          count: jest.fn().mockResolvedValue(4),
        },
        fullTextIndex: {
          findMany: jest.fn().mockResolvedValue([
            {
              attachmentId: 'att-pdf-1',
              pageIndex: 2,
              charOffset: 1000,
              textContent:
                'In Section 3,\nwe introduce\nScaled Dot-Product Attention\nas the core mechanism.\nFurthermore, scaled dot-product attention is fast.',
            },
          ]),
        },
        item: {
          groupBy: jest
            .fn()
            .mockResolvedValueOnce([
              { itemType: 'journalArticle', _count: { _all: 5 } },
              { itemType: 'conferencePaper', _count: { _all: 3 } },
            ])
            .mockResolvedValueOnce([{ year: 2024, _count: { _all: 8 } }]),
        },
        itemTag: {
          findMany: jest.fn().mockResolvedValue([]),
        },
      };

      const searchRepo = new SearchRepository(
        mockPrisma as unknown as ConstructorParameters<
          typeof SearchRepository
        >[0],
      );
      const fullTextProvider = new FullTextProvider(searchRepo);
      const searchService = new SearchService(searchRepo, fullTextProvider);

      // 1. Empty / whitespace term returns [] immediately without querying fullTextIndex
      const emptyAnchors = await searchService.searchPageAnchors(
        'user-1',
        'att-pdf-1',
        '   ',
      );
      expect(emptyAnchors).toEqual([]);
      expect(mockPrisma.fullTextIndex.findMany).not.toHaveBeenCalled();

      // 2. Valid technical phrase returns all occurrences with newline-normalized snippets & exact offsets
      const matches = await searchService.searchPageAnchors(
        'user-1',
        'att-pdf-1',
        'Scaled Dot-Product Attention',
      );
      expect(matches).toHaveLength(2);
      expect(matches[0].pageIndex).toBe(2);
      expect(matches[0].snippet).not.toContain('\n');
      expect(matches[0].snippet).toContain('Scaled Dot-Product Attention');
      expect(matches[0].charOffsetEnd - matches[0].charOffsetStart).toBe(
        'Scaled Dot-Product Attention'.length,
      );

      // 3. Cross-tenant / wrong project access throws NotFoundException
      await expect(
        searchService.searchPageAnchors(
          'user-1',
          'att-pdf-1',
          'Attention',
          undefined,
          'proj-unauthorized',
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // USER STORY 2: Zotero Sync Protocol — Delta Compaction, Tombstones, & OCC
  describe('User Story 2: Zotero Sync Protocol — Delta Compaction, Tombstones, & Optimistic Concurrency', () => {
    const userId = '11111111-1111-4111-8111-111111111111';
    const itemId = '22222222-2222-4222-8222-222222222222';
    const noteId = '33333333-3333-4333-8333-333333333333';

    it('rejects stale multi-tab item and note writes with VersionMismatchException when expectedVersion mismatches', async () => {
      let currentItemVersion = 1;
      let currentItemTitle = 'Initial Paper Title';

      const mockPrisma = {
        item: {
          findFirst: jest.fn().mockImplementation(() =>
            Promise.resolve({
              id: itemId,
              userId,
              projectId: null,
              deletedAt: null,
              version: currentItemVersion,
              title: currentItemTitle,
              itemType: 'journalArticle',
              metadata: {},
              notesList: [],
            }),
          ),
          findUnique: jest.fn().mockImplementation(() =>
            Promise.resolve({
              id: itemId,
              version: currentItemVersion,
            }),
          ),
          updateMany: jest
            .fn()
            .mockImplementation(({ where }: { where: { version: number } }) => {
              if (where.version !== currentItemVersion) {
                return Promise.resolve({ count: 0 });
              }
              currentItemVersion += 1;
              return Promise.resolve({ count: 1 });
            }),
          update: jest
            .fn()
            .mockImplementation(({ data }: { data: { title?: string } }) => {
              if (data.title) currentItemTitle = data.title;
              return Promise.resolve({
                id: itemId,
                userId,
                projectId: null,
                version: currentItemVersion,
                title: currentItemTitle,
                itemType: 'journalArticle',
                metadata: {},
                collectionItems: [],
                itemTags: [],
                contributors: [],
                attachments: [],
                notesList: [],
              });
            }),
        },
        note: {
          findFirst: jest.fn(),
          findUnique: jest.fn(),
          updateMany: jest.fn(),
          update: jest.fn(),
        },
      };

      const commandRepo = new CommandRepository(
        mockPrisma as unknown as ConstructorParameters<
          typeof CommandRepository
        >[0],
      );
      const queryRepo = new QueryRepository(
        mockPrisma as unknown as ConstructorParameters<
          typeof QueryRepository
        >[0],
      );
      const mockTxService = {
        executeInTransaction: jest
          .fn()
          .mockImplementation(async (fn: (...args: unknown[]) => unknown) =>
            fn(mockPrisma, {
              appendChange: jest.fn().mockResolvedValue(undefined),
              publishOutbox: jest.fn().mockResolvedValue(undefined),
              recordTombstone: jest.fn().mockResolvedValue(undefined),
            }),
          ),
      };
      const mockTagsService = {
        invalidateTagsCache: jest.fn().mockResolvedValue(undefined),
      };

      const itemService = new ItemService(
        queryRepo,
        commandRepo,
        mockTxService as unknown as TransactionService,
        mockTagsService as unknown as ConstructorParameters<
          typeof ItemService
        >[3],
      );

      // Tab A updates item from version 1 -> version 2
      const tabAUpdated = await itemService.updateItem(userId, itemId, 1, {
        title: 'Tab A Updated Title',
      });
      expect(tabAUpdated.version).toBe(2);

      // Tab B still holds stale expectedVersion: 1 -> must throw VersionMismatchException
      await expect(
        itemService.updateItem(userId, itemId, 1, {
          title: 'Tab B Stale Write',
        }),
      ).rejects.toThrow(VersionMismatchException);

      // Tab B passing stale expectedVersion inside payload object with undefined 3rd arg -> also rejected!
      await expect(
        itemService.updateItem(userId, itemId, undefined, {
          title: 'Tab B Stale Payload Write',
          expectedVersion: 1,
        }),
      ).rejects.toThrow(VersionMismatchException);

      // Now test NotesService OCC: Tab A updates note v1 -> v2, Tab B fails with stale v1
      let currentNoteVersion = 1;
      mockPrisma.note.findFirst.mockImplementation(() =>
        Promise.resolve({
          id: noteId,
          userId,
          projectId: null,
          deletedAt: null,
          version: currentNoteVersion,
          title: 'Note v1',
          contentMd: 'Initial content',
          tags: [],
        }),
      );
      mockPrisma.note.updateMany.mockImplementation(
        ({ where }: { where: { version: number } }) => {
          if (where.version !== currentNoteVersion) {
            return Promise.resolve({ count: 0 });
          }
          currentNoteVersion += 1;
          return Promise.resolve({ count: 1 });
        },
      );
      mockPrisma.note.update.mockImplementation(
        ({ data }: { data: { title?: string; contentMd?: string } }) =>
          Promise.resolve({
            id: noteId,
            userId,
            projectId: null,
            version: currentNoteVersion,
            title: data.title ?? 'Note',
            contentMd: data.contentMd ?? '',
            tags: [],
          }),
      );

      const notesRepo = new NotesRepository(
        mockPrisma as unknown as ConstructorParameters<
          typeof NotesRepository
        >[0],
      );
      const notesService = new NotesService(
        notesRepo,
        mockTxService as unknown as TransactionService,
      );

      const noteTabA = await notesService.updateNote(userId, noteId, {
        title: 'Tab A Note Title',
        contentMd: 'Tab A content',
        expectedVersion: 1,
      });
      expect(noteTabA.version).toBe(2);

      // Tab B attempts stale update with expectedVersion = 1
      await expect(
        notesService.updateNote(userId, noteId, {
          title: 'Tab B Stale Note',
          expectedVersion: 1,
        }),
      ).rejects.toThrow(VersionMismatchException);
    });

    it('compacts multi-step item mutations (v11..v15 updates followed by v16 delete, and ephemeral create->delete) via ChangeLogService & SyncController', async () => {
      const rawChanges = [
        // Item 1: updated 5 times (v11..v15) then deleted (v16)
        {
          id: 'c-11',
          seq: 11n,
          userId,
          projectId: null,
          entityType: 'Item',
          entityId: 'item-deleted-later',
          action: 'update',
          version: 2,
          data: { title: 'Edit 1' },
          createdAt: new Date('2026-10-14T10:01:00Z'),
        },
        {
          id: 'c-12',
          seq: 12n,
          userId,
          projectId: null,
          entityType: 'item',
          entityId: 'item-deleted-later',
          action: 'update',
          version: 3,
          data: { title: 'Edit 2', year: 2024 },
          createdAt: new Date('2026-10-14T10:02:00Z'),
        },
        {
          id: 'c-13',
          seq: 13n,
          userId,
          projectId: null,
          entityType: 'Item',
          entityId: 'item-deleted-later',
          action: 'update',
          version: 4,
          data: { title: 'Edit 3' },
          createdAt: new Date('2026-10-14T10:03:00Z'),
        },
        {
          id: 'c-14',
          seq: 14n,
          userId,
          projectId: null,
          entityType: 'Item',
          entityId: 'item-deleted-later',
          action: 'update',
          version: 5,
          data: { title: 'Edit 4' },
          createdAt: new Date('2026-10-14T10:04:00Z'),
        },
        {
          id: 'c-15',
          seq: 15n,
          userId,
          projectId: null,
          entityType: 'Item',
          entityId: 'item-deleted-later',
          action: 'update',
          version: 6,
          data: { title: 'Edit 5' },
          createdAt: new Date('2026-10-14T10:05:00Z'),
        },
        {
          id: 'c-16',
          seq: 16n,
          userId,
          projectId: null,
          entityType: 'Item',
          entityId: 'item-deleted-later',
          action: 'delete',
          version: 7,
          data: null,
          createdAt: new Date('2026-10-14T10:06:00Z'),
        },
        // Item 2: ephemeral item created at seq 17, updated at seq 18, deleted at seq 19 -> cancels out!
        {
          id: 'c-17',
          seq: 17n,
          userId,
          projectId: null,
          entityType: 'Item',
          entityId: 'item-ephemeral',
          action: 'create',
          version: 1,
          data: { title: 'Temp Draft' },
          createdAt: new Date('2026-10-14T10:07:00Z'),
        },
        {
          id: 'c-18',
          seq: 18n,
          userId,
          projectId: null,
          entityType: 'Item',
          entityId: 'item-ephemeral',
          action: 'update',
          version: 2,
          data: { title: 'Temp Draft Edited' },
          createdAt: new Date('2026-10-14T10:08:00Z'),
        },
        {
          id: 'c-19',
          seq: 19n,
          userId,
          projectId: null,
          entityType: 'Item',
          entityId: 'item-ephemeral',
          action: 'delete',
          version: 3,
          data: null,
          createdAt: new Date('2026-10-14T10:09:00Z'),
        },
        // Item 3: active item updated twice (seq 20, seq 21) -> merges payload data
        {
          id: 'c-20',
          seq: 20n,
          userId,
          projectId: null,
          entityType: 'Note',
          entityId: 'note-active',
          action: 'update',
          version: 2,
          data: { title: 'Updated Note Title', tags: ['ml'] },
          createdAt: new Date('2026-10-14T10:10:00Z'),
        },
        {
          id: 'c-21',
          seq: 21n,
          userId,
          projectId: null,
          entityType: 'Note',
          entityId: 'note-active',
          action: 'update',
          version: 3,
          data: { contentMd: 'Final markdown body' },
          createdAt: new Date('2026-10-14T10:11:00Z'),
        },
      ];

      const mockChangeLogRepo = {
        getChangesSince: jest.fn().mockResolvedValue(rawChanges),
        getTombstonesSince: jest.fn().mockResolvedValue([
          {
            id: 'tomb-1',
            seq: 16n,
            userId,
            projectId: null,
            entityType: 'Item',
            entityId: 'item-deleted-later',
            deletedById: userId,
            deletedAt: new Date('2026-10-14T10:06:00Z'),
          },
        ]),
        getLatestSequence: jest.fn().mockResolvedValue(21n),
      };

      const compacted = compactLibraryChanges(rawChanges);

      // Ephemeral item is completely omitted; only 'item-deleted-later' (final delete at seq 16)
      // and 'note-active' (merged update at seq 21) remain!
      expect(compacted).toHaveLength(2);
      expect(compacted[0]).toMatchObject({
        entityId: 'item-deleted-later',
        action: 'delete',
        seq: 16n,
        version: 7,
      });
      expect(compacted[1]).toMatchObject({
        entityId: 'note-active',
        action: 'update',
        seq: 21n,
        version: 3,
        data: {
          title: 'Updated Note Title',
          tags: ['ml'],
          contentMd: 'Final markdown body',
        },
      });

      // Verify SyncController endpoints for /sync/changes?since=10&compact=true and /sync/tombstones
      const mockTxService = {
        getChangesSince: jest.fn().mockResolvedValue(rawChanges),
        getTombstonesSince: mockChangeLogRepo.getTombstonesSince,
        getLatestSequence: mockChangeLogRepo.getLatestSequence,
      };
      const syncController = new SyncController(
        mockTxService as unknown as TransactionService,
      );

      const syncRes = await syncController.getChanges(userId, {
        since: '10',
        compact: true,
        limit: 50,
      });
      expect(syncRes.compacted).toBe(true);
      expect(syncRes.count).toBe(2);
      expect(syncRes.changes[0].seq).toBe('16');
      expect(syncRes.changes[0].action).toBe('delete');
      expect(syncRes.changes[1].seq).toBe('21');

      const tombRes = await syncController.getTombstones(userId, {
        since: '10',
        limit: 50,
      });
      expect(tombRes.count).toBe(1);
      expect(tombRes.tombstones[0].entityId).toBe('item-deleted-later');
      expect(tombRes.tombstones[0].seq).toBe('16');
    });
  });

  // USER STORY 3: 2-Column PDF Layout Extraction, Chunking & Reference Matching
  describe('User Story 3: 2-Column Academic PDF Layout Extraction, Scientific Chunking & Cited Reference Matching', () => {
    it('extracts Title, Authors, and Left-Column Abstract from a 2-column IEEE/ACM PDF without interleaving Right-Column body text', async () => {
      // Simulate a 2-column IEEE conference paper page where:
      // - Top banner (y=720..680, full width) has Title (18pt) and Authors (12pt)
      // - Left column (x=54, y=620..560, 10pt) has Abstract
      // - Right column (x=320, y=620..560, 10pt) has "II. RELATED WORK" and body text at the EXACT same y coordinates!
      const mockPdfDocument = {
        numPages: 1,
        getPage: jest.fn().mockResolvedValue({
          getTextContent: jest.fn().mockResolvedValue({
            items: [
              // Full-width Title (18pt)
              {
                str: 'Attention Is All You Need: A Transformer Architecture',
                transform: [18, 0, 0, 18, 72, 720],
              },
              // Full-width Authors (12pt)
              {
                str: 'Ashish Vaswani, Noam Shazeer, Niki Parmar',
                transform: [12, 0, 0, 12, 110, 690],
              },
              // Affiliation (should be ignored as author)
              {
                str: 'Department of Computer Science, Stanford University',
                transform: [10, 0, 0, 10, 120, 670],
              },
              // Left Column (x=54) Abstract AND Right Column (x=320) body text at identical Y coordinates!
              {
                str: 'Abstract—The dominant sequence transduction models',
                transform: [10, 0, 0, 10, 54, 620],
              },
              {
                str: 'II. RELATED WORK',
                transform: [10, 0, 0, 10, 320, 620],
              },
              {
                str: 'are based on complex recurrent or convolutional',
                transform: [10, 0, 0, 10, 54, 606],
              },
              {
                str: 'Prior sequence-to-sequence approaches relied heavily on',
                transform: [10, 0, 0, 10, 320, 606],
              },
              {
                str: 'neural networks that include an encoder and a decoder.',
                transform: [10, 0, 0, 10, 54, 592],
              },
              {
                str: 'recurrent gated cells across hundreds of time steps.',
                transform: [10, 0, 0, 10, 320, 592],
              },
              {
                str: '1. Introduction',
                transform: [10, 0, 0, 10, 54, 570],
              },
            ],
          }),
        }),
      };

      const extracted = await LayoutHeuristicExtractor.extract(
        Buffer.from('mock-pdf-bytes'),
        mockPdfDocument as unknown as Parameters<
          typeof LayoutHeuristicExtractor.extract
        >[1],
      );

      expect(extracted.title).toBe(
        'Attention Is All You Need: A Transformer Architecture',
      );
      expect(extracted.authors).toEqual([
        'Ashish Vaswani',
        'Noam Shazeer',
        'Niki Parmar',
      ]);
      expect(extracted.abstract).toBeDefined();
      expect(extracted.abstract).toContain(
        'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks',
      );
      // Right-column text at the same Y coordinates must NOT leak into the left-column Abstract!
      expect(extracted.abstract).not.toContain('RELATED WORK');
      expect(extracted.abstract).not.toContain('Prior sequence-to-sequence');
    });

    it('ScientificChunkingService detects both Arabic (1. Introduction, 3. Methodology) and Roman numeral (II. RELATED WORK) section headings', () => {
      const chunker = new ScientificChunkingService();
      const chunks = chunker.chunkPdfDocument({
        metadata: {
          title: 'Attention Is All You Need',
          authors: ['Ashish Vaswani', 'Noam Shazeer'],
          year: 2017,
        },
        pages: [
          {
            pageIndex: 0,
            charOffset: 0,
            textContent: [
              '1. Introduction',
              'Sequence transduction models are fundamental to machine translation.',
              'II. RELATED WORK',
              'Extended neural GPU and ByteNet reduce sequential computation using convolutions.',
              '3. Methodology',
              'The Transformer uses multi-head self-attention layers in both encoder and decoder.',
              'References',
              '[1] K. He et al., "Deep residual learning for image recognition," 2016.',
            ].join('\n'),
          },
        ],
      });

      const sectionNames = chunks.map((c) => c.section);
      expect(sectionNames).toContain('Introduction');
      expect(sectionNames).toContain('RELATED WORK');
      expect(sectionNames).toContain('Methodology');
      expect(sectionNames).toContain('References');
    });

    it('ReferenceMatcherService normalizes DOI URL prefixes, matches Title+Author+Year, prevents N+1 queries, and isolates personal vs project scope', async () => {
      const findManyMock = jest.fn().mockResolvedValue([
        {
          id: 'paper-vaswani-id',
          title: 'Attention Is All You Need',
          doi: 'https://doi.org/10.48550/arXiv.1706.03762',
          year: 2017,
          metadata: { arxivId: '1706.03762' },
          contributors: [{ lastName: 'Vaswani', fullName: 'Ashish Vaswani' }],
        },
        {
          id: 'paper-resnet-id',
          title: 'Deep Residual Learning for Image Recognition',
          doi: '10.1109/CVPR.2016.90',
          year: 2016,
          metadata: {},
          contributors: [{ lastName: 'He', fullName: 'Kaiming He' }],
        },
      ]);
      const upsertRelationMock = jest.fn().mockResolvedValue({});

      const mockPrisma = {
        item: {
          findMany: findManyMock,
        },
        itemRelation: {
          upsert: upsertRelationMock,
        },
      };

      const extractionRepo = new ExtractionRepository(
        mockPrisma as unknown as ConstructorParameters<
          typeof ExtractionRepository
        >[0],
      );
      const matcher = new ReferenceMatcherService(extractionRepo);

      // 1. Personal scope query must enforce { userId: 'user-1', projectId: null }
      const linkRes = await matcher.linkCitationsInLibrary(
        { userId: 'user-1', projectId: null },
        'source-paper-id',
        [
          // Reference 1: cited by quoted title + author + year (no DOI in bibliography text)
          {
            rawText:
              '[1] A. Vaswani et al., "Attention is all you need," in Advances in Neural Information Processing Systems, 2017.',
          },
          // Reference 2: cited with full DOI URL and trailing period
          {
            doi: 'https://dx.doi.org/10.1109/cvpr.2016.90.',
            title: 'Deep Residual Learning for Image Recognition',
          },
          // Reference 3: duplicate citation to Vaswani paper (by bare DOI) -> should be deduplicated!
          {
            doi: 'doi:10.48550/ARXIV.1706.03762',
          },
        ],
      );

      // Single DB query for candidate scope papers (no N+1 select queries!)
      expect(findManyMock).toHaveBeenCalledTimes(1);
      expect(findManyMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId: 'user-1',
            projectId: null,
            id: { not: 'source-paper-id' },
            deletedAt: null,
          },
        }),
      );

      // Both unique target papers matched; duplicate citation to Vaswani was deduplicated
      expect(linkRes.matchedCount).toBe(2);
      expect(upsertRelationMock).toHaveBeenCalledTimes(2);
      expect(linkRes.matches.map((m) => m.targetItemId).sort()).toEqual([
        'paper-resnet-id',
        'paper-vaswani-id',
      ]);
    });
  });

  // USER STORY 4: Manuscript / LaTeX Editor Integration via LibraryFacade
  describe('User Story 4: Manuscript / LaTeX Editor Integration via LibraryFacade & ExportsService.exportByCitationKeys', () => {
    it('resolves primary citationKeys, mergedCitationKeys (from duplicate merges), and BetterBibTeX tex.ids aliases so LaTeX manuscripts never suffer broken [?] citations', async () => {
      const survivorVaswaniItem = {
        id: '00000000-0000-4000-8000-000000000101',
        userId: 'user-1',
        projectId: null,
        itemType: 'conferencePaper',
        title: 'Attention Is All You Need',
        publicationTitle: 'Advances in Neural Information Processing Systems',
        year: 2017,
        doi: '10.48550/arXiv.1706.03762',
        url: 'https://arxiv.org/abs/1706.03762',
        abstract: null,
        citationKey: 'vaswani2017attention',
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        version: 3,
        metadata: {
          // Populated when user merged duplicate 'vaswani2017arxiv' into 'vaswani2017attention'
          mergedCitationKeys: ['vaswani2017arxiv', 'vaswani2017nips'],
          extra: 'arXiv: 1706.03762\ntex.ids: vaswani2017legacy',
        },
        contributors: [
          {
            id: 'c-1',
            itemId: '00000000-0000-4000-8000-000000000101',
            creatorType: 'author',
            firstName: 'Ashish',
            lastName: 'Vaswani',
            fullName: 'Ashish Vaswani',
            orderIndex: 0,
          },
        ],
      } as unknown as ExportItemRecord;

      const krawczykItem = {
        id: '00000000-0000-4000-8000-000000000102',
        userId: 'user-1',
        projectId: null,
        itemType: 'journalArticle',
        title:
          'Learning from Imbalanced Data: Open Challenges and Future Directions',
        publicationTitle: 'Progress in Artificial Intelligence',
        year: 2016,
        doi: '10.1007/s13748-016-0094-0',
        url: null,
        abstract: null,
        citationKey: 'krawczyk2016learning',
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        version: 1,
        metadata: {},
        contributors: [
          {
            id: 'c-2',
            itemId: '00000000-0000-4000-8000-000000000102',
            creatorType: 'author',
            firstName: 'Bartosz',
            lastName: 'Krawczyk',
            fullName: 'Bartosz Krawczyk',
            orderIndex: 0,
          },
        ],
      } as unknown as ExportItemRecord;

      // Simulate DB behavior:
      // 1st call (targetedScopeWhere with citationKey IN [...]) only matches krawczyk2016learning
      // because 'vaswani2017arxiv' and 'vaswani2017legacy' are in metadata, not the citationKey column!
      // 2nd call (scopeWhere fallback) returns all active items in scope so mergedCitationKeys & tex.ids resolve!
      const findItemsByScopeMock = jest
        .fn()
        .mockResolvedValueOnce([krawczykItem])
        .mockResolvedValueOnce([survivorVaswaniItem, krawczykItem]);

      const mockExportsRepo = {
        findItemsByScope: findItemsByScopeMock,
        findProjectMember: jest.fn().mockResolvedValue({ role: 'owner' }),
      };

      const cslEngine = new CslEngineService();
      const citationService = new CitationService(undefined, cslEngine);
      const exportsService = new ExportsService(
        mockExportsRepo as unknown as ExportsRepository,
        citationService,
        new PdfBakerService(),
      );
      const citationFacade = new CitationFacade(
        citationService,
        exportsService,
      );
      const mockCatalogFacade = {
        findMany: jest
          .fn()
          .mockResolvedValue([survivorVaswaniItem, krawczykItem]),
      };
      const mockSearchFacade = {
        search: jest.fn().mockResolvedValue({
          items: [survivorVaswaniItem, krawczykItem],
          total: 2,
        }),
      };
      const libraryFacade = new LibraryFacade(
        mockCatalogFacade as unknown as CatalogFacade,
        undefined as any,
        mockSearchFacade as unknown as any,
        citationFacade,
      );

      // Researcher searches items in the LaTeX editor
      const searchHits = await libraryFacade.searchItems('user-1', 'Attention');
      expect(searchHits).toHaveLength(2);
      expect(searchHits[0].authors).toContain('Ashish Vaswani');

      // Manuscript cites:
      // - 'vaswani2017arxiv' (merged duplicate key in metadata.mergedCitationKeys)
      // - 'vaswani2017legacy' (BetterBibTeX alias in Extra tex.ids)
      // - 'krawczyk2016learning' (primary citationKey)
      // - 'nonexistent2099key' (genuinely missing key)
      const exportRes = await libraryFacade.exportByCitationKeys('user-1', [
        'vaswani2017arxiv',
        'vaswani2017legacy',
        'krawczyk2016learning',
        'nonexistent2099key',
      ]);

      expect(exportRes.foundKeys).toEqual(
        expect.arrayContaining([
          'vaswani2017arxiv',
          'vaswani2017legacy',
          'krawczyk2016learning',
        ]),
      );
      expect(exportRes.missingKeys).toEqual(['nonexistent2099key']);
      expect(exportRes.count).toBe(3);

      // Generated .bib content must contain BibTeX blocks keyed by the exact cited keys
      // so \cite{vaswani2017arxiv}, \cite{vaswani2017legacy}, and \cite{krawczyk2016learning}
      // all compile cleanly in pdflatex/bibtex!
      expect(exportRes.content).toContain('@inproceedings{vaswani2017arxiv,');
      expect(exportRes.content).toContain('@inproceedings{vaswani2017legacy,');
      expect(exportRes.content).toContain('@article{krawczyk2016learning,');
      const unbracedBib = exportRes.content.replace(/[{}]/g, '');
      expect(unbracedBib).toContain('Attention Is All You Need');
      expect(unbracedBib).toContain('Learning from Imbalanced Data');
    });
  });
});
