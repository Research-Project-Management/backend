import { Prisma } from '@prisma/client';
import {
  ConditionEvaluatorEngine,
  evalJsonField,
} from '@/modules/library/catalog/domain/condition-evaluator.engine';
import { SavedSearchesRepository } from '@/modules/library/catalog/repositories/saved-searches.repository';
import { FeedsRepository } from '@/modules/library/ingestion/repositories/feeds.repository';
import { FeedRetrievalService } from '@/modules/library/ingestion/services/feed-retrieval.service';
import {
  parseAcademicFeedXml,
  promoteFeedEntryToLibrary,
  type FeedPromotionCatalogPort,
} from '@/modules/library/ingestion/parsers/rss-atom-feed.parser';
import { ExportsRepository } from '@/modules/library/citation/repositories/exports.repository';
import {
  BibtexExportStrategy,
  RisExportStrategy,
  CslJsonExportStrategy,
  CsvExportStrategy,
  toCitationItemInput,
} from '@/modules/library/citation/domain/export-format.strategies';
import { CslStyleFormatterService } from '@/modules/library/citation/services/csl-style-formatter.service';
import { CslJsonMapper } from '@/modules/library/citation/domain/csl-json.mapper';
import { TextSearchSpecification } from '@/modules/library/search/domain/item-specifications';
import { buildSearchFtsMatchingIdsSql } from '@/modules/library/search/repositories/search-sql.helper';
import { SearchRepository } from '@/modules/library/search/repositories/search.repository';
import { LIBRARY_REDIS_KEYS } from '@/modules/library/core';

describe('Horizontal Frond 3 — Smart Collections, Feeds, Export Round-Trip & Search/Sync Cache', () => {
  // ─────────────────────────────────────────────────────────────────────────
  // 1. Smart Collections / Saved Searches
  // ─────────────────────────────────────────────────────────────────────────
  describe('1. Smart Collections / Saved Searches', () => {
    const engine = new ConditionEvaluatorEngine();

    it('evalJsonField distinguishes exact equality (is/isNot), substring (contains/doesNotContain), and non-empty presence (isPresent)', () => {
      const isClause = evalJsonField('volume', 'is', '1');
      expect(isClause).toEqual({
        metadata: { path: ['volume'], equals: '1' },
      });

      const isNotClause = evalJsonField('volume', 'isNot', '1');
      expect(isNotClause).toEqual({
        NOT: { metadata: { path: ['volume'], equals: '1' } },
      });

      const containsClause = evalJsonField('volume', 'contains', '1');
      expect(containsClause).toEqual({
        metadata: { path: ['volume'], string_contains: '1' },
      });

      const doesNotContainClause = evalJsonField(
        'volume',
        'doesNotContain',
        '1',
      );
      expect(doesNotContainClause).toEqual({
        NOT: { metadata: { path: ['volume'], string_contains: '1' } },
      });

      const isPresentClause = evalJsonField('volume', 'isPresent', '');
      expect(isPresentClause).toEqual({
        AND: [
          { metadata: { path: ['volume'], not: Prisma.JsonNull } },
          { metadata: { path: ['volume'], not: '' } },
        ],
      });
    });

    it('ConditionEvaluatorEngine.evaluateLeaf delegates date range operators on publicationDate and accessedAt', () => {
      const pubGt = engine.evaluateLeaf({
        field: 'publicationDate',
        operator: 'isGreaterThan',
        value: '2021-05-01',
      });
      expect(pubGt).toEqual({ year: { gt: 2021 } });

      const pubBetween = engine.evaluateLeaf({
        field: 'publicationDate',
        operator: 'isBetween',
        value: ['2018-01-01', '2022-12-31'],
      });
      expect(pubBetween).toEqual({ year: { gte: 2018, lte: 2022 } });

      const accessedGt = engine.evaluateLeaf({
        field: 'accessedAt',
        operator: 'isGreaterThan',
        value: '2024-01-15T00:00:00.000Z',
      });
      expect(accessedGt).toEqual({
        accessedAt: { gt: new Date('2024-01-15T00:00:00.000Z') },
      });
    });

    it('ConditionEvaluatorEngine.evaluateLeaf expands type-specific title/publisher fields across JSON and base columns', () => {
      const bookTitleContains = engine.evaluateLeaf({
        field: 'bookTitle',
        operator: 'contains',
        value: 'Deep Learning',
      });
      expect(bookTitleContains).toEqual({
        OR: [
          {
            metadata: {
              path: ['bookTitle'],
              string_contains: 'Deep Learning',
            },
          },
          {
            publicationTitle: {
              contains: 'Deep Learning',
              mode: 'insensitive',
            },
          },
        ],
      });

      const proceedingsAbsent = engine.evaluateLeaf({
        field: 'proceedingsTitle',
        operator: 'isAbsent',
        value: '',
      });
      expect(proceedingsAbsent).toEqual({
        AND: [
          {
            OR: [
              { metadata: { path: ['proceedingsTitle'], equals: Prisma.JsonNull } },
              { metadata: { path: ['proceedingsTitle'], equals: '' } },
            ],
          },
          {
            OR: [{ publicationTitle: null }, { publicationTitle: '' }],
          },
        ],
      });

      const universityIs = engine.evaluateLeaf({
        field: 'university',
        operator: 'is',
        value: 'MIT',
      });
      expect(universityIs).toEqual({
        OR: [
          { metadata: { path: ['university'], equals: 'MIT' } },
          { metadata: { path: ['publisher'], equals: 'MIT' } },
        ],
      });

      const institutionIsNot = engine.evaluateLeaf({
        field: 'institution',
        operator: 'isNot',
        value: 'CERN',
      });
      expect(institutionIsNot).toEqual({
        AND: [
          { NOT: { metadata: { path: ['institution'], equals: 'CERN' } } },
          { NOT: { metadata: { path: ['publisher'], equals: 'CERN' } } },
        ],
      });
    });

    it('SavedSearchesRepository.findMatchingItems filters soft-deleted attachments and includes user states', async () => {
      const findManyMock = jest.fn().mockResolvedValue([]);
      const mockPrisma = {
        item: { findMany: findManyMock },
      };
      const repo = new SavedSearchesRepository(mockPrisma as never);

      const compiledWhere = engine.compile('user-abc', {
        conjunction: 'AND',
        conditions: [{ field: 'title', operator: 'contains', value: 'Flux' }],
      }) as Prisma.ItemWhereInput;

      await repo.findMatchingItems(compiledWhere, { limit: 10 });

      expect(findManyMock).toHaveBeenCalledWith(
        expect.objectContaining({
          include: expect.objectContaining({
            attachments: { where: { deletedAt: null }, take: 5 },
            states: { where: { userId: 'user-abc' }, take: 1 },
          }),
        }),
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 2. Feeds Promotion & Caching
  // ─────────────────────────────────────────────────────────────────────────
  describe('2. Feeds Promotion & Caching', () => {
    it('FeedsRepository.deleteFeedItemsOlderThan executes valid Prisma FeedItemWhereInput without non-existent states relation', async () => {
      const deleteManyMock = jest.fn().mockResolvedValue({ count: 3 });
      const repo = new FeedsRepository({
        feedItem: { deleteMany: deleteManyMock },
      } as never);

      const cutoff = new Date('2025-01-01T00:00:00.000Z');
      const count = await repo.deleteFeedItemsOlderThan(cutoff, 'feed-1');

      expect(count).toBe(3);
      expect(deleteManyMock).toHaveBeenCalledWith({
        where: {
          feedId: 'feed-1',
          publishedAt: { lt: cutoff },
        },
      });
    });

    it('FeedsRepository.persistFetchedFeedAndItems and mapCachedFeedToParsedFeed preserve structured creators (firstName/lastName/fieldMode)', async () => {
      let capturedCreateData: Record<string, unknown> | undefined;
      const mockPrisma = {
        feed: {
          upsert: jest.fn().mockResolvedValue({ id: 'feed-1' }),
        },
        feedItem: {
          upsert: jest.fn().mockImplementation((args: { create: Record<string, unknown> }) => {
            capturedCreateData = args.create;
            return Promise.resolve({ id: 'item-1' });
          }),
        },
      };
      const repo = new FeedsRepository(mockPrisma as never);

      await repo.persistFetchedFeedAndItems({
        feedUrl: 'https://arxiv.org/rss/cs.AI',
        parsed: {
          format: 'atom',
          feedTitle: 'arXiv CS.AI',
          entries: [
            {
              id: 'arxiv:2401.12345',
              title: 'Structured Creator Test',
              authors: ['Ada Lovelace', 'World Health Organization'],
              creators: [
                {
                  firstName: 'Ada',
                  lastName: 'Lovelace',
                  fullName: 'Ada Lovelace',
                  creatorType: 'author',
                },
                {
                  firstName: '',
                  lastName: 'World Health Organization',
                  fullName: 'World Health Organization',
                  fieldMode: 1,
                  creatorType: 'author',
                },
              ],
              keywords: ['cs.AI'],
              itemType: 'preprint',
            },
          ],
        },
      });

      expect(capturedCreateData?.authors).toEqual([
        expect.objectContaining({
          firstName: 'Ada',
          lastName: 'Lovelace',
          creatorType: 'author',
        }),
        expect.objectContaining({
          firstName: '',
          lastName: 'World Health Organization',
          fieldMode: 1,
          creatorType: 'author',
        }),
      ]);

      const mapped = repo.mapCachedFeedToParsedFeed({
        id: 'feed-1',
        url: 'https://arxiv.org/rss/cs.AI',
        title: 'arXiv CS.AI',
        items: [
          {
            id: 'item-1',
            title: 'Structured Creator Test',
            url: 'https://arxiv.org/abs/2401.12345',
            authors: [{ name: 'Alan Turing' }, ...(capturedCreateData?.authors as unknown[])],
          },
        ],
      });

      expect(mapped.entries[0].creators[0]).toEqual(
        expect.objectContaining({
          firstName: 'Alan',
          lastName: 'Turing',
        }),
      );
      expect(mapped.entries[0].creators[1]).toEqual(
        expect.objectContaining({
          firstName: 'Ada',
          lastName: 'Lovelace',
        }),
      );
      expect(mapped.entries[0].creators[2]).toEqual(
        expect.objectContaining({
          firstName: '',
          lastName: 'World Health Organization',
          fieldMode: 1,
        }),
      );
    });

    it('FeedRetrievalService.fallbackSearchFeed parses Crossref authors via parseCreatorString', async () => {
      const service = new FeedRetrievalService();
      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          message: {
            items: [
              {
                title: ['Quantum Networks'],
                DOI: '10.1101/2025.01.01.12345',
                author: [{ given: 'Grace', family: 'Hopper' }],
                published: { 'date-parts': [[2025, 1, 15]] },
              },
            ],
          },
        }),
      } as unknown as Response);

      try {
        const feed = await (
          service as unknown as {
            fallbackSearchFeed: (url: string) => ReturnType<FeedRetrievalService['fetchAcademicFeed']>;
          }
        ).fallbackSearchFeed('https://www.biorxiv.org/feed');

        expect(feed.entries[0].creators[0]).toEqual(
          expect.objectContaining({
            firstName: 'Grace',
            lastName: 'Hopper',
          }),
        );
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('parseAcademicFeedXml extracts PMID/PMCID, classifies arXiv/bioRxiv as preprint, and promoteFeedEntryToLibrary populates top-level fields', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:prism="http://prismstandard.org/namespaces/basic/2.0/">
          <channel>
            <title>bioRxiv Feed</title>
            <item>
              <title>Neural Decoding</title>
              <link>https://arxiv.org/abs/2402.00001v2</link>
              <dc:creator>Geoffrey Hinton</dc:creator>
              <dc:source>arXiv e-prints</dc:source>
              <prism:volume>42</prism:volume>
              <prism:number>7</prism:number>
              <prism:startingPage>100</prism:startingPage>
              <prism:endingPage>115</prism:endingPage>
              <dc:date>2024-02-10</dc:date>
              <dc:rights>CC-BY-4.0</dc:rights>
              <description>Abstract text here. PMID: 38123456 PMCID: PMC10987654</description>
            </item>
          </channel>
        </rss>`;

      const parsed = parseAcademicFeedXml(xml);
      expect(parsed.entries).toHaveLength(1);
      const entry = parsed.entries[0];
      expect(entry.itemType).toBe('preprint');
      expect(entry.arxivId).toBe('2402.00001v2');
      expect(entry.pmid).toBe('38123456');
      expect(entry.pmcid).toBe('PMC10987654');

      const createItemMock = jest.fn().mockResolvedValue({
        id: 'lib-item-1',
        title: entry.title,
      });
      const catalogPort: FeedPromotionCatalogPort = {
        createItem: createItemMock,
      };

      await promoteFeedEntryToLibrary(entry, 'user-1', catalogPort);
      expect(createItemMock).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          volume: '42',
          issue: '7',
          pages: '100-115',
          publicationDate: '2024-02-10',
          rights: 'CC-BY-4.0',
          arxivId: '2402.00001v2',
          pmid: '38123456',
          pmcid: 'PMC10987654',
          metadataSource: 'rss_atom_feed',
          creators: [
            expect.objectContaining({
              firstName: 'Geoffrey',
              lastName: 'Hinton',
            }),
          ],
        }),
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3. Export Strategies Round-Trip Fidelity
  // ─────────────────────────────────────────────────────────────────────────
  describe('3. Export Strategies Round-Trip Fidelity', () => {
    const formatter = new CslStyleFormatterService();
    const adapter = {
      formatItem: (input: unknown, style: string) => {
        const csl = CslJsonMapper.toCsl(input as never);
        return {
          bibliography:
            style === 'bibtex'
              ? formatter.formatBibtex(csl)
              : formatter.formatRis(csl),
        };
      },
    };

    const sampleRecord = {
      id: '11111111-2222-4333-8444-555555555555',
      userId: '22222222-2222-4333-8444-555555555555',
      projectId: null,
      itemType: 'bookSection',
      title: 'Attention Is All You Need',
      abstract: 'Transformers architecture paper.',
      publicationTitle: null,
      year: 2017,
      doi: '10.5555/3295222.3295349',
      url: 'https://arxiv.org/abs/1706.03762',
      citationKey: 'vaswani2017attention',
      firstAuthor: 'Vaswani',
      metadata: {
        bookTitle: 'Advances in Neural Information Processing Systems',
        publisher: 'Curran Associates',
        volume: '30',
        issue: '2',
        pages: '5998-6008',
        isbn: '978-1-5108-6096-4',
        issn: '1049-5258',
        pmid: '29123456',
        arxivId: '1706.03762',
      },
      contributors: [
        {
          id: 'c1',
          itemId: '11111111-2222-4333-8444-555555555555',
          creatorType: 'author',
          firstName: 'Ashish',
          lastName: 'Vaswani',
          fullName: 'Ashish Vaswani',
          fieldMode: 0,
          orderIndex: 0,
        },
        {
          id: 'c2',
          itemId: '11111111-2222-4333-8444-555555555555',
          creatorType: 'editor',
          firstName: '',
          lastName: 'Neural Information Processing Foundation',
          fullName: 'Neural Information Processing Foundation',
          fieldMode: 1,
          orderIndex: 1,
        },
      ],
      itemTags: [{ tag: { name: 'transformers' } }, { tag: { name: 'nlp' } }],
      notesList: [
        {
          id: 'n1',
          title: 'Key Insight',
          contentMd: 'Self-attention replaces recurrence.',
          deletedAt: null,
        },
      ],
      createdAt: new Date('2025-01-01T00:00:00Z'),
      updatedAt: new Date('2025-01-02T00:00:00Z'),
      deletedAt: null,
      version: 1,
    };

    it('ExportsRepository includes itemTags and notesList on bulk/single export queries', async () => {
      const findManyMock = jest.fn().mockResolvedValue([]);
      const repo = new ExportsRepository({
        item: { findMany: findManyMock },
      } as never);

      await repo.fetchItemsInChunks({ userId: 'u1', deletedAt: null }, 10, 10);
      expect(findManyMock).toHaveBeenCalledWith(
        expect.objectContaining({
          include: expect.objectContaining({
            contributors: { orderBy: { orderIndex: 'asc' } },
            itemTags: { include: { tag: true } },
            notesList: { where: { deletedAt: null } },
          }),
        }),
      );
    });

    it('BibTeX export wraps institutional editors in double braces and includes keywords & annote from itemTags/notesList', () => {
      const bibStrategy = new BibtexExportStrategy();
      const res = bibStrategy.exportItems({
        items: [sampleRecord as never],
        timestamp: '2026-10-27',
        citationFormatter: adapter,
      });

      expect(res.content).toContain(
        'editor = {{Neural Information Processing Foundation}}',
      );
      expect(res.content).toContain('keywords = {transformers, nlp}');
      expect(res.content).toContain('Self-attention replaces recurrence.');
      expect(res.content).toContain('eprint = {1706.03762}');
    });

    it('RIS export emits N1 - arXiv:<id> when _arxivId is present', () => {
      const risStrategy = new RisExportStrategy();
      const res = risStrategy.exportItems({
        items: [sampleRecord as never],
        timestamp: '2026-10-27',
        citationFormatter: adapter,
      });

      expect(res.content).toContain('N1  - arXiv:1706.03762');
      expect(res.content).toContain('KW  - transformers');
    });

    it('CSL-JSON export preserves arXiv ID in note before stripping internal _ keys', () => {
      const cslStrategy = new CslJsonExportStrategy();
      const res = cslStrategy.exportItems({
        items: [sampleRecord as never],
        timestamp: '2026-10-27',
      });

      const parsed = JSON.parse(res.content) as Array<Record<string, unknown>>;
      expect(parsed[0]._arxivId).toBeUndefined();
      expect(parsed[0].note).toContain('arXiv: 1706.03762');
    });

    it('CSV export falls back publicationTitle to bookTitle/proceedingsTitle and exports all 18 columns', () => {
      const csvStrategy = new CsvExportStrategy();
      const res = csvStrategy.exportItems({
        items: [sampleRecord as never],
        timestamp: '2026-10-27',
      });

      const lines = res.content.split(/\r?\n/);
      expect(lines[0]).toBe(
        'id,title,authors,year,publicationTitle,publisher,doi,itemType,citationKey,url,abstract,volume,issue,pages,isbn,issn,pmid,arxivId',
      );
      expect(lines[1]).toContain(
        '"Advances in Neural Information Processing Systems"',
      );
      expect(lines[1]).toContain('"Transformers architecture paper."');
      expect(lines[1]).toContain('"5998-6008"');
      expect(lines[1]).toContain('"978-1-5108-6096-4"');
      expect(lines[1]).toContain('"1706.03762"');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 4. Search Engine & Sync Cache Invalidation
  // ─────────────────────────────────────────────────────────────────────────
  describe('4. Search Engine & Sync Cache Invalidation', () => {
    it('TextSearchSpecification includes publicationTitle and uses plural fullTextIndexes relation', () => {
      const spec = new TextSearchSpecification('Nature Photonics');
      const where = spec.toPrismaWhere() as { OR: Array<Record<string, unknown>> };

      expect(where.OR).toContainEqual({
        publicationTitle: { contains: 'Nature Photonics', mode: 'insensitive' },
      });
      expect(where.OR).toContainEqual({
        attachments: {
          some: {
            deletedAt: null,
            fullTextIndexes: {
              some: {
                textContent: {
                  contains: 'Nature Photonics',
                  mode: 'insensitive',
                },
              },
            },
          },
        },
      });

      expect(
        spec.isSatisfiedBy({
          title: 'Unrelated Title',
          publicationTitle: 'Nature Photonics Letters',
        }),
      ).toBe(true);

      expect(
        spec.isSatisfiedBy({
          title: 'Unrelated',
          attachments: [
            {
              deletedAt: null,
              fullTextIndexes: [{ textContent: 'Published in Nature Photonics' }],
            },
          ],
        }),
      ).toBe(true);
    });

    it('buildSearchFtsMatchingIdsSql applies structural filters before LIMIT 5000', () => {
      const userId = '11111111-2222-4333-8444-555555555555';
      const collectionId = '22222222-3333-4444-8555-666666666666';
      const tagId = '33333333-4444-4555-8666-777777777777';

      const built = buildSearchFtsMatchingIdsSql({
        userId,
        queryText: 'quantum',
        options: {
          q: 'quantum',
          itemType: 'journalArticle',
          yearFrom: 2020,
          yearTo: 2025,
          collectionId,
          tagId,
        },
      });

      expect(built).not.toBeNull();
      expect(built!.sql).toContain('"type" = $3');
      expect(built!.sql).toContain('year >= $4');
      expect(built!.sql).toContain('year <= $5');
      expect(built!.sql).toContain('ci.collection_id = $6::uuid');
      expect(built!.sql).toContain('it.tag_id = $7::uuid');
      expect(built!.params).toEqual([
        userId,
        'quantum',
        'journalArticle',
        2020,
        2025,
        collectionId,
        tagId,
      ]);
    });

    it('SearchRepository aligns Redis version key between invalidateFacets and searchItems/computeFacets', async () => {
      const store = new Map<string, unknown>();
      const mockCache = {
        get: jest.fn(async (k: string) => store.get(k) ?? null),
        set: jest.fn(async (k: string, v: unknown) => {
          store.set(k, v);
        }),
        delPattern: jest.fn(async () => {}),
        wrap: jest.fn(async (k: string, fn: () => Promise<unknown>) => {
          if (store.has(k)) return store.get(k);
          const v = await fn();
          store.set(k, v);
          return v;
        }),
      };
      const mockPrisma = {
        item: {
          groupBy: jest.fn().mockResolvedValue([]),
          findMany: jest.fn().mockResolvedValue([]),
        },
        itemTag: {
          findMany: jest.fn().mockResolvedValue([]),
        },
      };

      const repo = new SearchRepository(
        mockPrisma as never,
        mockCache as never,
      );
      const userId = '11111111-2222-4333-8444-555555555555';

      await repo.computeFacets(userId, { q: 'neural' });
      const firstFacetCall = mockCache.set.mock.calls.find(([k]) =>
        String(k).includes('library:search:facets:'),
      );
      const firstFacetKey = firstFacetCall?.[0] as string;
      expect(firstFacetKey).toContain(':v1:');

      await repo.invalidateFacets(userId);
      expect(store.get(LIBRARY_REDIS_KEYS.searchVersion(userId))).toBe('2');

      await repo.computeFacets(userId, { q: 'neural' });
      const lastSetCall =
        mockCache.set.mock.calls[mockCache.set.mock.calls.length - 1];
      expect(lastSetCall[0]).toContain(':v2:');
      expect(lastSetCall[0]).not.toBe(firstFacetKey);
    });
  });
});
