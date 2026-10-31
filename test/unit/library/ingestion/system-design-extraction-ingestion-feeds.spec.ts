import { ExtractionMetadataSynchronizer } from '../../../../src/modules/library/extraction/services/extraction-metadata.synchronizer';
import { ExtractionRepository } from '../../../../src/modules/library/extraction/repositories/extraction.repository';
import { TrustedExtractionService } from '../../../../src/modules/library/extraction/services/trusted-extraction.service';
import { RetractionRepository } from '../../../../src/modules/library/ingestion/repositories/retraction.repository';
import { IngestionRepository } from '../../../../src/modules/library/ingestion/repositories/ingestion.repository';
import { FeedsRepository } from '../../../../src/modules/library/ingestion/repositories/feeds.repository';
import { FeedRetrievalService } from '../../../../src/modules/library/ingestion/services/feed-retrieval.service';
import { MetadataResolverService } from '../../../../src/modules/library/ingestion/services/metadata-resolver.service';
import { EnrichStage } from '../../../../src/modules/library/ingestion/stages/enrich.stage';
import { CommitStage } from '../../../../src/modules/library/ingestion/stages/commit.stage';
import { serializeSubRunRecordPayload } from '../../../../src/modules/library/ingestion/services/pipeline-batch.executor';

describe('System Design Phase 4 Loop 2 — Extraction, Ingestion, Feeds & Retraction (SDE2)', () => {
  describe('Group 1: Extraction Provenance, Sync & Lock Enforcement (SD1-07, SD2-01, SD2-02, SD2-03)', () => {
    it('SD2-01 & SD1-07: ExtractionRepository.syncExtractedIdentifiers respects field locks and fresh-item conflicts, and updateItemWithExtractedMetadata preserves tags/keywords', async () => {
      const upsertCalls: Array<{ type: string; value: string }> = [];
      const itemUpdateCalls: Array<{ data: Record<string, unknown> }> = [];
      const freshRow = {
        id: 'item-1',
        userId: 'user-1',
        projectId: null,
        version: 3,
        doi: '10.1000/user-locked',
        title: 'User Title',
        abstract: null,
        year: null,
        publicationTitle: null,
        itemType: 'journalArticle',
        citationKey: 'user2026',
        metadata: {
          arxivId: '2401.99999',
          tags: ['SyncTag'],
          keywords: ['SyncTag'],
          lockedFields: ['doi'],
          fieldProvenance: {
            doi: { source: 'UserOverride', isUserOverride: true, confidence: 1.0 },
          },
        },
      };

      const mockTx = {
        item: {
          findUnique: jest.fn().mockResolvedValue(freshRow),
          findFirst: jest.fn().mockResolvedValue(freshRow),
          update: jest.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
            itemUpdateCalls.push(args);
            return Promise.resolve({
              id: 'item-1',
              userId: 'user-1',
              version: 4,
              contributors: [],
              itemTags: [],
              collectionItems: [],
              attachments: [],
              notesList: [],
              identifiers: [],
            });
          }),
        },
        itemIdentifier: {
          upsert: jest.fn().mockImplementation((args: { create: { type: string; value: string } }) => {
            upsertCalls.push({ type: args.create.type, value: args.create.value });
            return Promise.resolve({});
          }),
        },
      };

      const repo = new ExtractionRepository({} as never);
      await repo.syncExtractedIdentifiers(
        'item-1',
        [
          { type: 'DOI', value: '10.1000/hallucinated-pdf-doi', canonicalUri: 'https://doi.org/10.1000/hallucinated-pdf-doi' },
          { type: 'ARXIV', value: '2401.00001', canonicalUri: 'https://arxiv.org/abs/2401.00001' },
          { type: 'PMID', value: '99887766', canonicalUri: 'https://pubmed.ncbi.nlm.nih.gov/99887766/' },
        ],
        mockTx as never,
      );

      // DOI is locked and conflicts with freshItem.doi; ARXIV conflicts with freshMeta.arxivId; only pmid should be upserted
      expect(upsertCalls).toEqual([{ type: 'pmid', value: '99887766' }]);

      await repo.updateItemWithExtractedMetadata(
        'item-1',
        {
          abstract: 'Extracted abstract',
          metadata: {
            tags: ['StaleOverwriteAttempt'],
            keywords: ['StaleOverwriteAttempt'],
            fieldProvenance: {
              abstractNote: { source: 'PDF_EXTRACTION:LAYOUT_HEURISTIC', confidence: 0.75 },
              tags: { source: 'PDF_EXTRACTION:LAYOUT_HEURISTIC', confidence: 0.75 },
            },
          },
        },
        mockTx as never,
      );

      expect(itemUpdateCalls).toHaveLength(1);
      const savedMeta = itemUpdateCalls[0].data.metadata as Record<string, unknown>;
      // Freshest DB tags written by syncItemTags in the same transaction are preserved
      expect(savedMeta.tags).toEqual(['SyncTag']);
      expect(savedMeta.keywords).toEqual(['SyncTag']);
      const savedProv = savedMeta.fieldProvenance as Record<string, { source: string }>;
      expect(savedProv.doi.source).toBe('UserOverride');
      expect(savedProv.abstractNote.source).toBe('PDF_EXTRACTION:LAYOUT_HEURISTIC');
      expect(savedProv.tags.source).toBe('PDF_EXTRACTION:LAYOUT_HEURISTIC');
    });

    it('SD2-02 & SD2-03: TrustedExtractionService and ExtractionMetadataSynchronizer preserve per-field tier provenance and emit single-version update on contributor/tag-only sync', async () => {
      const trustedService = new TrustedExtractionService();
      const xmpBuffer = Buffer.from(
        '%PDF-1.4\n<x:xmpmeta><rdf:RDF><rdf:Description><prism:doi>10.1234/xmp.5678</prism:doi></rdf:Description></rdf:RDF></x:xmpmeta>\n',
        'utf-8',
      );
      const fakePdfDoc = {
        numPages: 1,
        getPage: jest.fn().mockResolvedValue({
          getViewport: () => ({ width: 600, height: 800 }),
          getTextContent: jest.fn().mockResolvedValue({
            items: [
              { str: 'Deep Learning for Citations', transform: [18, 0, 0, 18, 50, 720], width: 250, height: 18 },
              { str: 'Ada Lovelace', transform: [12, 0, 0, 12, 50, 690], width: 120, height: 12 },
              { str: 'Abstract—A novel architecture for citation graphs in digital libraries.', transform: [10, 0, 0, 10, 50, 640], width: 400, height: 10 },
            ],
          }),
        }),
      };

      const trustedRes = await trustedService.extract(
        xmpBuffer,
        '2024_fallback_file.pdf',
        fakePdfDoc as never,
      );

      expect(trustedRes.provenance.fieldProvenance).toBeDefined();
      expect(trustedRes.provenance.fieldProvenance?.doi?.source).toBe('XMP_BINARY');
      expect(trustedRes.provenance.fieldProvenance?.doi?.confidence).toBe(0.95);

      const updateItemMock = jest.fn().mockResolvedValue({
        id: 'item-2',
        userId: 'user-1',
        version: 2,
        title: 'Existing Locked Title',
      });
      const createContributorsMock = jest.fn().mockResolvedValue(undefined);
      const syncTagsMock = jest.fn().mockResolvedValue(undefined);
      const mockRepo = {
        saveMetadataSourceRecord: jest.fn().mockResolvedValue({}),
        countContributors: jest.fn().mockResolvedValue(0),
        createContributors: createContributorsMock,
        countItemTags: jest.fn().mockResolvedValue(0),
        syncItemTags: syncTagsMock,
        countItemNotes: jest.fn().mockResolvedValue(0),
        createItemNotes: jest.fn().mockResolvedValue(0),
        syncExtractedIdentifiers: jest.fn().mockResolvedValue(undefined),
        updateItem: updateItemMock,
      };
      const appendChangeMock = jest.fn().mockResolvedValue(undefined);
      const publishOutboxMock = jest.fn().mockResolvedValue(undefined);
      const mockLibraryTx = {
        executeInTransaction: jest.fn().mockImplementation(async (fn: (tx: unknown, helpers: unknown) => Promise<void>) =>
          fn({}, { appendChange: appendChangeMock, publishOutbox: publishOutboxMock }),
        ),
      };

      const synchronizer = new ExtractionMetadataSynchronizer(
        mockRepo as never,
        mockLibraryTx as never,
      );

      await synchronizer.offloadFullTextAndSyncMetadata(
        {
          id: 'att-1',
          itemId: 'item-2',
          item: {
            id: 'item-2',
            userId: 'user-1',
            projectId: null,
            title: 'Existing Locked Title',
            doi: '10.1234/xmp.5678',
            abstract: 'Existing abstract',
            year: 2024,
            publicationTitle: 'Existing Venue',
            itemType: 'journalArticle',
            citationKey: 'lovelace2024existing',
            metadata: {},
          },
        },
        {
          fullText: 'Full text content',
          metadata: {
            authors: ['Ada Lovelace'],
            keywords: ['Graph Neural Networks'],
            fieldProvenance: {
              authors: { source: 'LAYOUT_HEURISTIC', confidence: 0.75 },
              keywords: { source: 'LAYOUT_HEURISTIC', confidence: 0.75 },
            },
          } as never,
        },
        { text: 'Full text content', pageCount: 10 },
      );

      // Contributors and tags were synced with skipVersionIncrement: true
      expect(createContributorsMock).toHaveBeenCalledWith(
        expect.any(Array),
        {},
        { skipVersionIncrement: true },
      );
      expect(syncTagsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          itemId: 'item-2',
          skipVersionIncrement: true,
        }),
        {},
      );
      // updateItem was called once to bump version, persist fieldProvenance, and emit changelog/outbox
      expect(updateItemMock).toHaveBeenCalledTimes(1);
      const updatePayload = updateItemMock.mock.calls[0][1] as {
        metadata: { fieldProvenance: Record<string, { source: string; confidence: number }> };
      };
      expect(updatePayload.metadata.fieldProvenance.creators.source).toBe('LAYOUT_HEURISTIC');
      expect(updatePayload.metadata.fieldProvenance.creators.confidence).toBe(0.75);
      expect(updatePayload.metadata.fieldProvenance.tags.source).toBe('LAYOUT_HEURISTIC');
      expect(appendChangeMock).toHaveBeenCalledTimes(1);
      expect(publishOutboxMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('Group 2: Retraction & Identifier Relational Integrity (SD1-04, SD1-08)', () => {
    it('SD1-08: RetractionRepository queries relational identifiers, extracts DOI/PMID from identifiers relation, and includes full relations on updateItemRetraction', async () => {
      const validItemId = '11111111-1111-4111-8111-111111111111';
      const validUserId = '22222222-2222-4222-8222-222222222222';
      const findManyMock = jest.fn().mockResolvedValue([
        {
          id: validItemId,
          title: 'Rel Only Item',
          doi: null,
          pmid: null,
          isbn: null,
          metadata: {},
          identifiers: [
            { type: 'DOI', value: '10.5555/rel-doi' },
            { type: 'PMID', value: '44556677' },
          ],
        },
      ]);
      const updateMock = jest.fn().mockResolvedValue({
        id: validItemId,
        userId: validUserId,
        projectId: null,
        itemType: 'journalArticle',
        title: 'Rel Only Item',
        version: 2,
        createdAt: new Date(),
        updatedAt: new Date(),
        contributors: [
          {
            id: 'c-1',
            itemId: validItemId,
            creatorType: 'author',
            orderIndex: 0,
            fullName: 'Jane Doe',
            firstName: 'Jane',
            lastName: 'Doe',
          },
        ],
        itemTags: [],
        collectionItems: [],
        attachments: [],
        notesList: [],
        identifiers: [{ id: 'id-1', itemId: validItemId, type: 'doi', value: '10.5555/rel-doi' }],
      });

      const mockPrisma = {
        item: {
          findMany: findManyMock,
          findUnique: jest.fn().mockResolvedValue({
            id: validItemId,
            userId: validUserId,
            projectId: null,
            metadata: {},
          }),
          update: updateMock,
        },
        $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockPrisma)),
      };

      const repo = new RetractionRepository(mockPrisma as never);
      const scanItems = await repo.findItemsForScan(validUserId);

      expect(scanItems).toHaveLength(1);
      expect(scanItems[0].doi).toBe('10.5555/rel-doi');
      expect(scanItems[0].pmid).toBe('44556677');
      expect(findManyMock.mock.calls[0][0].where.OR).toContainEqual({
        identifiers: { some: { type: { in: ['doi', 'pmid', 'arxiv'] } } },
      });

      const updatedDomain = await repo.updateItemRetraction(validItemId, true, 'Retraction');
      expect(updateMock).toHaveBeenCalledTimes(1);
      expect(updateMock.mock.calls[0][0].include).toMatchObject({
        contributors: expect.any(Object),
        itemTags: expect.any(Object),
        collectionItems: expect.any(Object),
        attachments: expect.any(Object),
        notesList: expect.any(Object),
        identifiers: true,
      });
      expect((updatedDomain as unknown as { contributors?: unknown[] })?.contributors).toHaveLength(1);
    });

    it('SD1-04: IngestionRepository.findItemByIdentifier supports ISBN and queries relational ItemIdentifier table', async () => {
      const findFirstMock = jest.fn().mockResolvedValue(null);
      const repo = new IngestionRepository({ item: { findFirst: findFirstMock } } as never);

      await repo.findItemByIdentifier('ISBN', '978-0-262-03384-8', { userId: 'user-1', projectId: null });
      expect(findFirstMock).toHaveBeenCalledTimes(1);
      const whereArg = findFirstMock.mock.calls[0][0].where;
      expect(whereArg.OR).toContainEqual({
        identifiers: {
          some: {
            type: 'isbn',
            value: { in: ['9780262033848', '978-0-262-03384-8'] },
          },
        },
      });
    });
  });

  describe('Group 3: Feeds Repository & Retrieval Correctness (SD1-10, SD1-11, SD1-12, SD1-13)', () => {
    it('SD1-10, SD1-11, SD1-12: FeedsRepository omits non-existent states filter, pushes retention cutoffs into SQL, filters active feeds by subscription, and round-trips academic metadata', async () => {
      const deleteManyMock = jest.fn().mockResolvedValue({ count: 5 });
      const findManyItemsMock = jest.fn().mockResolvedValue([]);
      const findManyFeedsMock = jest.fn().mockResolvedValue([]);
      const upsertItemMock = jest.fn().mockResolvedValue({});

      const mockPrisma = {
        feedItem: {
          deleteMany: deleteManyMock,
          findMany: findManyItemsMock,
          upsert: upsertItemMock,
        },
        feed: {
          findMany: findManyFeedsMock,
          upsert: jest.fn().mockResolvedValue({ id: 'feed-1', url: 'https://nature.com/rss', title: 'Nature Feed' }),
        },
      };

      const repo = new FeedsRepository(mockPrisma as never);

      // 1) deleteFeedItemsOlderThan has no bogus states filter
      const cutoff = new Date('2025-01-01T00:00:00.000Z');
      await repo.deleteFeedItemsOlderThan(cutoff);
      expect(deleteManyMock).toHaveBeenCalledWith({
        where: { publishedAt: { lt: cutoff } },
      });

      // 2) findFeedItemsForUser pushes readCutoff and unreadCutoff into Prisma where before take: limit
      await repo.findFeedItemsForUser({
        userId: 'user-1',
        feedId: 'feed-1',
        readStatus: 'all',
        limit: 25,
        cleanupReadAfter: 7,
        cleanupUnreadAfter: 30,
      });
      const feedItemsQuery = findManyItemsMock.mock.calls[0][0];
      expect(feedItemsQuery.take).toBe(25);
      expect(feedItemsQuery.where.AND).toHaveLength(2);
      expect(feedItemsQuery.where.AND[0]).toEqual({
        OR: [
          { readStates: { none: { userId: 'user-1' } } },
          { readStates: { some: { userId: 'user-1', readAt: { gte: expect.any(Date) } } } },
        ],
      });
      expect(feedItemsQuery.where.AND[1]).toEqual({
        OR: [
          { readStates: { some: { userId: 'user-1' } } },
          { publishedAt: { gte: expect.any(Date) } },
        ],
      });

      // 3) findActiveFeedsForPolling includes subscriptions: { some: {} }
      await repo.findActiveFeedsForPolling(10);
      expect(findManyFeedsMock.mock.calls[0][0].where).toMatchObject({
        errorCount: { lt: 5 },
        subscriptions: { some: {} },
      });

      // 4) persistFetchedFeedAndItems & mapCachedFeedToParsedFeed round-trip academic metadata
      await repo.persistFetchedFeedAndItems({
        feedUrl: 'https://nature.com/rss',
        parsed: {
          format: 'atom',
          feedTitle: 'Nature Feed',
          feedUrl: 'https://nature.com/rss',
          entries: [
            {
              id: 'guid-1',
              title: 'Quantum Paper',
              url: 'https://nature.com/q1',
              authors: ['Alice', 'Bob'],
              creators: [],
              publicationTitle: 'Nature',
              volume: '650',
              issue: '4',
              pages: '100-108',
              pmid: '88776655',
              pmcid: 'PMC88776655',
              keywords: ['Quantum'],
              itemType: 'journalArticle',
            },
          ],
        },
      });

      expect(upsertItemMock).toHaveBeenCalledTimes(1);
      const createdRow = upsertItemMock.mock.calls[0][0].create;
      expect(JSON.parse(createdRow.comments)).toMatchObject({
        pmid: '88776655',
        pmcid: 'PMC88776655',
        publicationTitle: 'Nature',
        volume: '650',
        issue: '4',
        pages: '100-108',
        keywords: ['Quantum'],
        itemType: 'journalArticle',
      });

      const mapped = repo.mapCachedFeedToParsedFeed({
        id: 'feed-1',
        url: 'https://nature.com/rss',
        title: 'Nature Feed',
        items: [
          {
            id: 'item-row-1',
            title: 'Quantum Paper',
            url: 'https://nature.com/q1',
            pdfUrl: null,
            doi: '10.1038/s41586-026-00001-1',
            arxivId: null,
            primaryCategory: 'Physics',
            authors: [{ name: 'Alice' }],
            abstract: 'Abstract',
            license: null,
            comments: createdRow.comments,
            publishedAt: new Date('2026-03-01T00:00:00.000Z'),
          },
        ],
      });

      expect(mapped.entries[0]).toMatchObject({
        pmid: '88776655',
        pmcid: 'PMC88776655',
        publicationTitle: 'Nature',
        volume: '650',
        issue: '4',
        pages: '100-108',
        keywords: ['Quantum'],
        itemType: 'journalArticle',
      });
    });

    it('SD1-13: FeedRetrievalService.fallbackSearchFeed does not synthesize fake https://doi.org pdfUrl when application/pdf link is absent', async () => {
      const service = new FeedRetrievalService({} as never);
      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          message: {
            items: [
              {
                DOI: '10.1000/no-pdf-link',
                title: ['Paper Without Direct PDF'],
                link: [{ URL: 'https://publisher.example.com/html', 'content-type': 'text/html' }],
              },
              {
                DOI: '10.1000/with-pdf-link',
                title: ['Paper With Direct PDF'],
                link: [{ URL: 'https://publisher.example.com/paper.pdf', 'content-type': 'application/pdf' }],
              },
            ],
          },
        }),
      } as Response);

      try {
        const parsed = await (
          service as unknown as {
            fallbackSearchFeed: (url: string) => Promise<{ entries: Array<{ doi?: string; pdfUrl?: string }> }>;
          }
        ).fallbackSearchFeed('https://example.com/Topic/Artificial%20Intelligence');

        expect(parsed.entries).toHaveLength(2);
        expect(parsed.entries[0].doi).toBe('10.1000/no-pdf-link');
        expect(parsed.entries[0].pdfUrl).toBeUndefined();
        expect(parsed.entries[1].doi).toBe('10.1000/with-pdf-link');
        expect(parsed.entries[1].pdfUrl).toBe('https://publisher.example.com/paper.pdf');
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  describe('Group 4 & 5: Ingestion Pipeline & Stage Completeness (SD2-05, SD2-06, SD2-07, SD2-08)', () => {
    it('SD2-05: MetadataResolverService.reconcileExtractedCandidate Page-1 Citation Trap clears unlocked arxivId/pmid/isbn even when resolved.metadata.doi is absent', async () => {
      const updateItemMock = jest.fn().mockResolvedValue(undefined);
      const mockCatalogGateway = {
        getItem: jest.fn().mockResolvedValue({
          id: 'item-trap',
          title: 'Completely Unrelated Working Paper on Macroeconomics',
          doi: undefined,
          isbn: undefined,
          pmid: undefined,
          year: 2026,
          extraFields: {
            arxivId: '2101.12345',
          },
          identifiers: [{ type: 'ARXIV', value: '2101.12345' }],
        }),
        updateItem: updateItemMock,
      };
      const mockMetadataService = {
        resolve: jest.fn().mockResolvedValue({
          provider: 'arxiv',
          confidence: 0.95,
          metadata: {
            title: 'Attention Is All You Need: A Cited Reference Paper From Page 1',
            // Note: no DOI returned by arXiv resolver!
            arxivId: '2101.12345',
            year: 2021,
          },
        }),
      };

      const resolver = new MetadataResolverService(
        mockCatalogGateway as never,
        mockMetadataService as never,
      );

      await resolver.reconcileExtractedCandidate({
        userId: 'user-1',
        itemId: 'item-trap',
        extractedMetadata: {
          title: 'Completely Unrelated Working Paper on Macroeconomics',
          arxivId: '2101.12345',
        },
      });

      expect(updateItemMock).toHaveBeenCalledTimes(1);
      const patchArg = updateItemMock.mock.calls[0][2];
      // Unlocked cited arXiv ID must be cleared to null
      expect(patchArg.arxivId).toBeNull();
      expect(patchArg.extraFields.arxivId).toBeNull();
    });

    it('SD2-06: EnrichStage preserves UserOverride fields in emitted provider candidates and keeps fields and normalizedMetadata consistent', async () => {
      const enrichStage = new EnrichStage({
        resolve: jest.fn().mockResolvedValue({
          provider: 'crossref',
          canonicalId: '10.1000/test-enrich',
          resolvedAt: '2026-03-01T00:00:00.000Z',
          confidence: 0.95,
          metadata: {
            title: 'Provider Overwrite Title',
            publicationTitle: 'Journal of Computing',
            year: 2025,
          },
        }),
      } as never);

      const candidates = [
        {
          candidateId: 'cand-1',
          sourceKind: 'RECORD' as const,
          sourceName: 'UserOverride',
          confidenceScore: 1.0,
          retrievedAt: '2026-03-01T00:00:00.000Z',
          schemaVersion: '1.0.0',
          fields: {
            title: {
              path: 'title',
              value: 'User Locked Custom Title',
              normalizedValue: 'User Locked Custom Title',
              confidence: 1.0,
              sourceProvider: 'UserOverride',
              retrievedAt: '2026-03-01T00:00:00.000Z',
            },
            doi: {
              path: 'doi',
              value: '10.1000/test-enrich',
              normalizedValue: '10.1000/test-enrich',
              confidence: 1.0,
              sourceProvider: 'UserOverride',
              retrievedAt: '2026-03-01T00:00:00.000Z',
            },
          },
          normalizedMetadata: {
            title: 'User Locked Custom Title',
            doi: '10.1000/test-enrich',
          },
        },
      ];

      const resultCandidates = await enrichStage.execute({
        scopeId: 'user-1',
        candidates,
      });

      expect(resultCandidates).toHaveLength(2);
      const emitted = resultCandidates[1];
      expect(emitted.sourceName).toBe('crossref');
      // UserOverride title was NOT included in the provider candidate's fields OR normalizedMetadata
      expect(emitted.fields.title).toBeUndefined();
      expect(emitted.normalizedMetadata.title).toBeUndefined();
      // Non-locked enriched field is present in both
      expect(emitted.fields.publicationTitle?.normalizedValue).toBe('Journal of Computing');
      expect(emitted.normalizedMetadata.publicationTitle).toBe('Journal of Computing');
    });

    it('SD2-07: serializeSubRunRecordPayload produces valid CSL_JSON record payload', () => {
      const payload = serializeSubRunRecordPayload({
        candidateId: 'cand-batch-1',
        sourceKind: 'RECORD',
        sourceName: 'Parser',
        confidenceScore: 0.8,
        retrievedAt: '2026-03-01T00:00:00.000Z',
        schemaVersion: '1.0.0',
        fields: {},
        normalizedMetadata: { title: 'Batch Item', doi: '10.1000/batch-1' },
      });

      expect(payload.kind).toBe('RECORD');
      expect(payload.format).toBe('CSL_JSON');
      expect(JSON.parse(payload.content)).toEqual([{ title: 'Batch Item', doi: '10.1000/batch-1' }]);
    });

    it('SD2-08: CommitStage.enrichMatchedExistingItem invokes snapshot, relation sync, notes materialization, and collection assignment', async () => {
      const saveSnapshotMock = jest.fn().mockResolvedValue(undefined);
      const syncRelationsMock = jest.fn().mockResolvedValue(undefined);
      const materializeNotesMock = jest.fn().mockResolvedValue(undefined);
      const assignCollectionMock = jest.fn().mockResolvedValue(undefined);

      const mockCatalogGateway = {
        getPrimaryCreatorType: jest.fn().mockReturnValue('author'),
        findMatchCandidates: jest.fn().mockResolvedValue({
          exactMatch: { id: 'existing-item-1', title: 'Existing Item' },
        }),
        getItem: jest.fn().mockResolvedValue({
          id: 'existing-item-1',
          title: 'Existing Item',
          extraFields: {},
          identifiers: [],
        }),
        updateItem: jest.fn().mockResolvedValue({
          id: 'existing-item-1',
          title: 'Existing Item',
          abstract: 'New Abstract',
        }),
        assignItemsToCollection: assignCollectionMock,
      };

      const commitStage = new CommitStage(
        mockCatalogGateway as never,
        {
          saveItemMetadataSnapshot: saveSnapshotMock,
          syncRelationsForCommittedItem: syncRelationsMock,
          materializeNotes: materializeNotesMock,
        },
      );

      await commitStage.execute({
        scopeId: { userId: 'user-1', projectId: 'proj-1' },
        item: {
          title: 'Existing Item',
          doi: '10.1000/match-1',
          abstract: 'New Abstract',
          notes: [{ content: 'Imported Note 1' }],
          tags: ['TagA'],
        },
        options: {
          userId: 'user-1',
          collectionIds: ['col-1'],
        },
      });

      expect(saveSnapshotMock).toHaveBeenCalledWith(
        'existing-item-1',
        expect.objectContaining({ doi: '10.1000/match-1' }),
      );
      expect(syncRelationsMock).toHaveBeenCalledWith(
        'existing-item-1',
        expect.objectContaining({ tags: ['TagA'] }),
        { userId: 'user-1', projectId: 'proj-1' },
      );
      expect(materializeNotesMock).toHaveBeenCalledWith(
        'user-1',
        'proj-1',
        'existing-item-1',
        [{ content: 'Imported Note 1' }],
        expect.objectContaining({ id: 'existing-item-1' }),
      );
      expect(assignCollectionMock).toHaveBeenCalledWith(
        'user-1',
        'col-1',
        ['existing-item-1'],
        'proj-1',
      );
    });
  });
});
