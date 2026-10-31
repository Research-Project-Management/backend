import { CommandRepository } from '@/modules/library/catalog/repositories/command.repository';
import {
  setMyPublicationInClient,
  syncUpdatedIdentifiers,
} from '@/modules/library/catalog/repositories/command-relations.helper';
import {
  calculateIdentifierChanges,
  normalizeItemIdentifiers,
} from '@/modules/library/catalog/domain/identifier-change.helper';
import { harmonizeDomainMetadataAndIdentifiersPartial } from '@/modules/library/catalog/domain/item-bibliographic.mapper';
import { ConditionEvaluatorEngine } from '@/modules/library/catalog/domain/condition-evaluator.engine';
import { buildItemSearchCondition } from '@/modules/library/catalog/repositories/item-filter-where.builder';
import { AcademicSearchQueryEngine } from '@/modules/library/core/domain/academic-search-query.domain';
import { buildSearchFtsSqlQuery, buildSearchFtsMatchingIdsSql } from '@/modules/library/search/repositories/search-sql.helper';
import { SearchRepository } from '@/modules/library/search/repositories/search.repository';
import { ItemMatchQueryRepository } from '@/modules/library/catalog/repositories/item-match-query.repository';
import {
  DoiExactMatchSpecification,
  ArxivExactMatchSpecification,
  PmidExactMatchSpecification,
  IsbnExactMatchSpecification,
} from '@/modules/library/catalog/domain/match-specifications.domain';
import { ExportsRepository } from '@/modules/library/citation/repositories/exports.repository';
import { QueryRepository } from '@/modules/library/catalog/repositories/query.repository';
import { SavedSearchesRepository } from '@/modules/library/catalog/repositories/saved-searches.repository';
import { CatalogFacade } from '@/modules/library/catalog/catalog.facade';
import { ItemCurationService } from '@/modules/library/catalog/services/item-curation.service';
import { LibraryFacade } from '@/modules/library/library.facade';
import { formatCsvExport } from '@/modules/library/citation/domain/export-format.strategies';
import {
  CsvExportStrategy,
  CslJsonExportStrategy,
} from '@/modules/library/citation/domain/export-format.strategies';
import { CslJsonMapper } from '@/modules/library/citation/domain/csl-json.mapper';
import { CslEngineService } from '@/modules/library/citation/services/csl-engine.service';

describe('System Design Phase 4 Loop 2 — Catalog, Query, Search & Citation Export (SD1-01..SD1-06, SD1-14..SD1-16, SD2-04, SD2-11)', () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  const itemId = '22222222-2222-4222-8222-222222222222';
  const projectId = '33333333-3333-4333-8333-333333333333';

  describe('SD1-01: CommandRepository.create attaches relational identifiers & calculateIdentifierChanges diffs non-6-key types', () => {
    it('attaches identifiersToCreate onto returned item when client.item.create returns empty identifiers', async () => {
      const upsertIdent = jest.fn().mockResolvedValue({});
      const mockPrisma = {
        item: {
          findMany: jest.fn().mockResolvedValue([]),
          create: jest.fn().mockResolvedValue({
            id: itemId,
            userId,
            title: 'Test Paper',
            itemType: 'journalArticle',
            identifiers: [],
          }),
        },
        itemIdentifier: {
          upsert: upsertIdent,
        },
      };
      const repo = new CommandRepository(mockPrisma as never);
      const created = await repo.create(userId, {
        title: 'Test Paper',
        doi: '10.1038/nature14539',
        identifiers: [{ type: 'openalex', value: 'W2100837269' }],
      });

      expect(upsertIdent).toHaveBeenCalledTimes(2);
      expect(created.identifiers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'doi', value: '10.1038/nature14539' }),
          expect.objectContaining({ type: 'openalex', value: 'W2100837269' }),
        ]),
      );
    });

    it('diffs explicit non-6-key identifiers (oclc, lccn, openalex, s2, wikidata) on update', async () => {
      const cleanIds = normalizeItemIdentifiers({ doi: '10.1000/182' }, { preserveOnInvalid: true });
      const existing = {
        id: itemId,
        doi: '10.1000/182',
        identifiers: [
          { type: 'doi', value: '10.1000/182' },
          { type: 'oclc', value: '11111' },
        ],
      };

      const changes = calculateIdentifierChanges(cleanIds, existing, [
        { type: 'oclc', value: '22222' },
        { type: 'openalex', value: 'W999999' },
        { type: 'wikidata', value: 'Q42', canonicalUri: 'https://www.wikidata.org/wiki/Q42' },
      ]);

      expect(changes).toEqual([
        { type: 'oclc', value: '22222', canonicalUri: '' },
        { type: 'openalex', value: 'W999999', canonicalUri: '' },
        { type: 'wikidata', value: 'Q42', canonicalUri: 'https://www.wikidata.org/wiki/Q42' },
      ]);

      const upsertMock = jest.fn().mockResolvedValue({});
      await syncUpdatedIdentifiers(
        { itemIdentifier: { upsert: upsertMock, deleteMany: jest.fn() } },
        itemId,
        cleanIds,
        existing,
        [{ type: 's2', value: 'S2-ID-123' }],
      );
      expect(upsertMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { itemId_type: { itemId, type: 's2' } },
          create: expect.objectContaining({ type: 's2', value: 'S2-ID-123' }),
        }),
      );
    });
  });

  describe('SD1-02: harmonizeDomainMetadataAndIdentifiersPartial treats relational identifiers as authoritative & merges missing canonical types', () => {
    it('overrides stale top-level/metadata identifier with relational ItemIdentifier value and merges missing canonical types into it.identifiers', () => {
      const payload: Record<string, unknown> = {
        itemType: 'journalArticle',
        doi: '10.1000/stale',
        isbn: '9780262035613',
        pmid: '12345678',
        identifiers: [
          { type: 'doi', value: '10.1000/authoritative', canonicalUri: 'https://doi.org/10.1000/authoritative' },
          { type: 'openalex', value: 'W12345', canonicalUri: null },
        ],
      };

      harmonizeDomainMetadataAndIdentifiersPartial(payload);

      expect(payload.doi).toBe('10.1000/authoritative');
      expect(payload.DOI).toBe('10.1000/authoritative');
      const idents = payload.identifiers as Array<{ type: string; value: string }>;
      expect(idents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'doi', value: '10.1000/authoritative' }),
          expect.objectContaining({ type: 'openalex', value: 'W12345' }),
          expect.objectContaining({ type: 'isbn', value: '9780262035613' }),
          expect.objectContaining({ type: 'pmid', value: '12345678' }),
        ]),
      );
    });
  });

  describe('SD1-03: Relational ItemIdentifier querying across ConditionEvaluatorEngine, ItemFilterWhereBuilder, AcademicSearchQueryEngine & SearchSqlHelper', () => {
    it('includes relational identifiers in ConditionEvaluatorEngine for identifier fields and anyField', () => {
      const engine = new ConditionEvaluatorEngine();
      const isbnLeaf = engine.evaluateLeaf({
        field: 'isbn',
        operator: 'is',
        value: '978-0-262-03561-3',
      });
      expect(JSON.stringify(isbnLeaf)).toContain('"identifiers"');
      expect(JSON.stringify(isbnLeaf)).toContain('9780262035613');

      const anyLeaf = engine.evaluateLeaf({
        field: 'anyField',
        operator: 'contains',
        value: '2106.01234',
      });
      expect(JSON.stringify(anyLeaf)).toContain('"identifiers"');
    });

    it('includes relational identifiers in buildItemSearchCondition and AcademicSearchQueryEngine', () => {
      const clauses = buildItemSearchCondition('10.1038/nature14539', 'fields_tags');
      expect(JSON.stringify(clauses)).toContain('"identifiers"');

      const extracted = AcademicSearchQueryEngine.extractIdentifiers('PMID: 25996635');
      const orClauses = AcademicSearchQueryEngine.buildMetadataIdentifierOrClauses(extracted);
      expect(orClauses).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            identifiers: {
              some: { type: 'pmid', value: { contains: '25996635', mode: 'insensitive' } },
            },
          }),
        ]),
      );

      expect(
        AcademicSearchQueryEngine.matchesItemIdentifiersInMemory(
          {
            metadata: {},
            identifiers: [{ type: 'pmid', value: '25996635' }],
          },
          extracted,
        ),
      ).toBe(true);
    });

    it('includes EXISTS (SELECT 1 FROM "item_identifiers" ...) in FTS SQL builders', () => {
      const ftsQuery = buildSearchFtsSqlQuery({
        userId,
        options: { q: '10.1038/nature14539' },
        queryText: '10 1038 nature14539',
        limit: 20,
      });
      expect(ftsQuery?.sql).toContain('FROM "item_identifiers" ii WHERE ii."item_id" = "items"."id"');

      const ftsIdsQuery = buildSearchFtsMatchingIdsSql({
        userId,
        options: { q: 'arXiv:2106.01234' },
        queryText: 'arxiv 2106 01234',
      });
      expect(ftsIdsQuery?.sql).toContain('FROM "item_identifiers" ii WHERE ii."item_id" = "items"."id"');
    });
  });

  describe('SD1-04 & SD2-11: ItemMatchQueryRepository & MatchSpecifications relational identifiers and primary creators', () => {
    it('includes relational identifiers and all creatorType roles in ItemMatchQueryRepository queries', async () => {
      const findManyMock = jest.fn().mockResolvedValue([]);
      const findFirstMock = jest.fn().mockResolvedValue(null);
      const repo = new ItemMatchQueryRepository({
        item: { findMany: findManyMock, findFirst: findFirstMock },
      } as never);

      await repo.findDuplicateCandidateItems(undefined, userId, 100);
      expect(findManyMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          select: expect.objectContaining({
            identifiers: { select: { type: true, value: true, canonicalUri: true } },
            contributors: {
              select: expect.objectContaining({ creatorType: true }),
              orderBy: { orderIndex: 'asc' },
            },
          }),
        }),
      );

      await repo.findQualityAuditItems(undefined, userId, 100);
      expect(findManyMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          select: expect.objectContaining({
            identifiers: { select: { type: true, value: true, canonicalUri: true } },
            contributors: {
              select: { id: true, creatorType: true },
            },
          }),
        }),
      );

      await repo.findMatchCandidates(undefined, { userId }, { doi: '10.1000/182' });
      expect(findFirstMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          select: expect.objectContaining({
            identifiers: { select: { type: true, value: true, canonicalUri: true } },
          }),
        }),
      );
    });

    it('includes relational identifiers and archiveID in ExactMatchSpecifications.toPrismaOrClauses', () => {
      const input = {
        cleanDoi: '10.1000/182',
        cleanArxiv: '2106.01234v2',
        cleanPmid: '12345678',
        cleanIsbn: '9780262035613',
      };
      const doiClauses = new DoiExactMatchSpecification().toPrismaOrClauses(input);
      const arxivClauses = new ArxivExactMatchSpecification().toPrismaOrClauses(input);
      const pmidClauses = new PmidExactMatchSpecification().toPrismaOrClauses(input);
      const isbnClauses = new IsbnExactMatchSpecification().toPrismaOrClauses(input);

      expect(JSON.stringify(doiClauses)).toContain('"identifiers"');
      expect(JSON.stringify(arxivClauses)).toContain('"archiveID"');
      expect(JSON.stringify(arxivClauses)).toContain('"identifiers"');
      expect(JSON.stringify(pmidClauses)).toContain('"identifiers"');
      expect(JSON.stringify(isbnClauses)).toContain('"identifiers"');
    });
  });

  describe('SD1-05: Relational identifiers included across ExportsRepository, QueryRepository, SavedSearchesRepository, SearchRepository, CommandRepository', () => {
    it('includes identifiers: true in ExportsRepository, SavedSearchesRepository, SearchRepository, and QueryRepository', async () => {
      const findManyMock = jest.fn().mockResolvedValue([]);
      const findFirstMock = jest.fn().mockResolvedValue({
        id: itemId,
        userId,
        title: 'Snap Title',
        metadata: {},
        itemTags: [],
        identifiers: [
          { type: 'issn', value: '1234-5678' },
          { type: 'isbn', value: '9780262035613' },
        ],
      });
      const exportsRepo = new ExportsRepository({
        item: { findMany: findManyMock, findFirst: findFirstMock },
      } as never);
      await exportsRepo.findItems({ userId });
      expect(findManyMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          include: expect.objectContaining({ identifiers: true }),
        }),
      );

      const queryRepo = new QueryRepository({
        item: { findFirst: findFirstMock, findMany: findManyMock },
      } as never);
      const snap = await queryRepo.getItemSnapshot(userId, itemId);
      expect(snap?.issn).toBe('1234-5678');
      expect(snap?.isbn).toBe('9780262035613');

      await queryRepo.findByDoi(userId, '10.1000/182');
      expect(findFirstMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          include: expect.objectContaining({ identifiers: true }),
        }),
      );

      const savedSearchRepo = new SavedSearchesRepository({
        item: { findMany: findManyMock },
      } as never);
      await savedSearchRepo.findMatchingItems({ userId }, { userId });
      expect(findManyMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          include: expect.objectContaining({ identifiers: true }),
        }),
      );

      const searchRepo = new SearchRepository({
        item: { findMany: findManyMock },
      } as never);
      await searchRepo.searchItems(userId, { q: '' });
      expect(findManyMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          include: expect.objectContaining({ identifiers: true }),
        }),
      );

      const updateMock = jest.fn().mockResolvedValue({ id: itemId });
      await setMyPublicationInClient(
        {
          item: {
            findFirst: jest.fn().mockResolvedValue({ id: itemId, userId, metadata: {} }),
            update: updateMock,
          },
          userPublication: { upsert: jest.fn(), deleteMany: jest.fn() },
        } as never,
        userId,
        itemId,
        true,
      );
      expect(updateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          include: expect.objectContaining({ identifiers: true }),
        }),
      );
    });
  });

  describe('SD1-06 & SD2-04: LibraryFacade.updateItemAiMetadata preserves relations, syncs ItemIdentifier, and invalidates write caches', () => {
    it('loads full relations, syncs ItemIdentifier, publishes complete domain item to outbox, and calls invalidateForWrite', async () => {
      const upsertIdent = jest.fn().mockResolvedValue({});
      const updateItem = jest.fn().mockResolvedValue({
        id: itemId,
        userId,
        projectId,
        title: 'AI Extracted Title',
        itemType: 'journalArticle',
        doi: '10.1038/s41586-021-03819-2',
        version: 2,
      });
      const mockPrisma = {
        item: {
          findUnique: jest.fn().mockResolvedValue({
            id: itemId,
            userId,
            projectId,
            title: 'Untitled.pdf',
            itemType: 'journalArticle',
            version: 1,
            metadata: { isFilenameTitle: true },
            contributors: [{ firstName: 'John', lastName: 'Jumper', creatorType: 'author', orderIndex: 0 }],
            itemTags: [{ tag: { id: 't1', name: 'alphafold' } }],
            collectionItems: [],
            attachments: [{ id: 'att-1', filename: 'paper.pdf' }],
            notesList: [],
            identifiers: [],
          }),
          update: updateItem,
        },
        itemIdentifier: {
          upsert: upsertIdent,
          deleteMany: jest.fn(),
        },
      };
      const appendChange = jest.fn();
      const publishOutbox = jest.fn();
      const uow = {
        executeInTransaction: (fn: (tx: unknown, h: unknown) => Promise<void>) =>
          fn(mockPrisma, { appendChange, publishOutbox }),
      };
      const coordinator = {
        invalidateForWrite: jest.fn().mockResolvedValue(undefined),
        invalidateItemCache: jest.fn().mockResolvedValue(undefined),
      };

      const curationService = new ItemCurationService(
        new QueryRepository(mockPrisma as never),
        new CommandRepository(mockPrisma as never),
        uow as never,
        undefined,
        undefined,
        coordinator as never,
      );
      const catalogFacade = new CatalogFacade(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        curationService,
      );
      const facade = new LibraryFacade(
        catalogFacade,
        {} as never,
        {} as never,
        {} as never,
      );

      await facade.updateItemAiMetadata(itemId, {
        title: 'Highly accurate protein structure prediction with AlphaFold',
        doi: '10.1038/s41586-021-03819-2',
        pmid: '34265844',
      });

      expect(upsertIdent).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { itemId_type: { itemId, type: 'doi' } },
        }),
      );
      expect(upsertIdent).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { itemId_type: { itemId, type: 'pmid' } },
        }),
      );
      expect(publishOutbox).toHaveBeenCalledWith(
        { userId, projectId },
        itemId,
        expect.any(String),
        expect.objectContaining({
          authors: ['John Jumper'],
          tags: expect.arrayContaining(['alphafold']),
        }),
      );
      expect(coordinator.invalidateForWrite).toHaveBeenCalledWith({
        userId,
        projectId,
        itemIds: [itemId],
      });
    });
  });

  describe('SD1-14, SD1-15, SD1-16: CSV CRLF & 18-col unification, CslJsonMapper cache immutability, and CslEngineService batch year-suffix disambiguation', () => {
    it('SD1-14: unifies CsvExportStrategy and formatCsvExport on 18 columns, CRLF line endings, and text/csv; charset=utf-8', () => {
      const strategy = new CsvExportStrategy();
      expect(strategy.mimeType).toBe('text/csv; charset=utf-8');
      const res = strategy.exportItems({
        items: [
          {
            id: itemId,
            title: 'Test CSV',
            year: 2024,
            itemType: 'journalArticle',
            contributors: [{ firstName: 'Jane', lastName: 'Doe', creatorType: 'author', orderIndex: 0 }],
            metadata: { volume: '12', issue: '3', pages: '10-20', isbn: '9780262035613' },
          } as never,
        ],
        timestamp: '2026-10-28',
      });
      expect(res.content).toContain('\r\n');
      const headerCols = res.content.split('\r\n')[0].split(',');
      expect(headerCols).toHaveLength(18);
      expect(headerCols).toContain('arxivId');
      expect(formatCsvExport([{ id: itemId, title: 'Direct CSV' }])).toContain('\r\n');
    });

    it('SD1-15: prevents CslJsonExportStrategy and callers from mutating cached CslJsonMapper.toCsl objects', () => {
      const sourceItem = {
        id: itemId,
        version: 1,
        updatedAt: new Date('2026-01-01T00:00:00Z'),
        itemType: 'preprint',
        title: 'Immutable Preprint',
        arxivId: '2301.00001',
        extra: 'Custom Note Line',
      };

      const firstCsl = CslJsonMapper.toCsl(sourceItem);
      firstCsl.note = 'MUTATED BY CALLER';

      const secondCsl = CslJsonMapper.toCsl(sourceItem);
      expect(secondCsl.note).not.toBe('MUTATED BY CALLER');

      const cslStrategy = new CslJsonExportStrategy();
      cslStrategy.exportItems({
        items: [sourceItem as never],
        timestamp: '2026-10-28',
      });
      const thirdCsl = CslJsonMapper.toCsl(sourceItem);
      expect(thirdCsl.note).toBe(secondCsl.note);
    });

    it('SD1-16: applies batch-level year-suffix disambiguation (2020a, 2020b) in CslEngineService.formatBatch and formatBatchAsync', async () => {
      const engine = new CslEngineService();
      const batchItems = [
        {
          id: 'smith2020first',
          type: 'article-journal',
          title: 'First Paper on Quantum Networks',
          author: [{ family: 'Smith', given: 'Alice' }],
          issued: { 'date-parts': [[2020]] },
          'container-title': 'Journal of Physics',
        },
        {
          id: 'smith2020second',
          type: 'article-journal',
          title: 'Second Paper on Quantum Computing',
          author: [{ family: 'Smith', given: 'Alice' }],
          issued: { 'date-parts': [[2020]] },
          'container-title': 'Journal of Physics',
        },
      ];

      const syncBatch = engine.formatBatch(batchItems, 'apa');
      expect(syncBatch.citations[0].inText).toContain('2020a');
      expect(syncBatch.citations[1].inText).toContain('2020b');
      expect(syncBatch.citations[0].bibliography).toContain('2020a');
      expect(syncBatch.citations[1].bibliography).toContain('2020b');

      const asyncBatch = await engine.formatBatchAsync(batchItems, 'apa');
      expect(asyncBatch.citations[0].inText).toContain('2020a');
      expect(asyncBatch.citations[1].inText).toContain('2020b');
    });
  });
});
