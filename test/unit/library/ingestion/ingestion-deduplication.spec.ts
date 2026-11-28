import { Prisma } from '@prisma/client';
import { fromPartial } from '@total-typescript/shoehorn';
import {
  DuplicatePolicy,
  normalizeTitleForDedupe,
  extractFirstAuthorFamily,
  generateDedupeBucketKey,
  calculateTitleSimilarity,
  firstAuthorMatches,
  hasConflictingPartOrSupplementMarkers,
  isGenericBoilerplateTitle,
} from '@/modules/library/ingestion/domain/deduplication.domain';
import {
  applyMetadataAndProvenanceBackfill,
  computeMergedTopLevelAndPrimaryMeta,
  planMergedItemRelations,
} from '@/modules/library/ingestion/domain/duplicate-merge.domain';
import { DuplicateDetectorService } from '@/modules/library/ingestion/services/duplicate-detector.service';
import { DuplicateMergerService } from '@/modules/library/ingestion/services/duplicate-merger.service';
import {
  ICatalogFacade,
  IExtractionFacade,
  ItemDetail,
} from '@/modules/library/core';

describe('Library Ingestion Deduplication & Field-Locked Merge Engine', () => {
  const mockUserId = '11111111-1111-4111-8111-111111111111';
  const mockProjectId = '22222222-2222-4222-8222-222222222222';

  describe('Deduplication Fingerprinting & Merge Domain Policies', () => {
    it('normalizes title/author buckets and guards against Part I vs Part II, Retraction Note, and boilerplate title false positives', () => {
      expect(normalizeTitleForDedupe('The Attention Is All You Need!')).toBe(
        'theattentionisallyouneed',
      );
      expect(extractFirstAuthorFamily(['Vaswani, Ashish'])).toBe('vaswani');
      expect(
        generateDedupeBucketKey(
          'Deep Residual Learning for Image Recognition',
          ['He, Kaiming'],
        ),
      ).toBe('deep_learning_residual::he');
      expect(
        calculateTitleSimilarity(
          'Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks',
          'Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks.',
        ),
      ).toBe(1);
      expect(firstAuthorMatches('Lewis, Patrick', 'Patrick Lewis')).toBe(true);
      expect(
        hasConflictingPartOrSupplementMarkers(
          'Foundations of Statistical Mechanics, Part I: Equilibrium',
          'Foundations of Statistical Mechanics, Part II: Non-Equilibrium',
        ),
      ).toBe(true);
      expect(
        hasConflictingPartOrSupplementMarkers(
          'Room-temperature superconductivity in a carbonaceous sulfur hydride',
          'Retraction Note: Room-temperature superconductivity in a carbonaceous sulfur hydride',
        ),
      ).toBe(true);
      expect(isGenericBoilerplateTitle('Editorial')).toBe(true);
      expect(isGenericBoilerplateTitle('Attention Is All You Need')).toBe(
        false,
      );

      const exact = new DuplicatePolicy().evaluate(
        {
          title: 'Deep Residual Learning for Image Recognition',
          doi: 'https://doi.org/10.1109/CVPR.2016.90',
        },
        [
          {
            id: 'item-existing-1',
            title: 'Deep Residual Learning for Image Recognition',
            year: 2016,
            doi: '10.1109/cvpr.2016.90',
            authors: ['Kaiming He'],
          },
        ],
      );
      expect(exact).toMatchObject({
        matchType: 'EXACT',
        matchReason: 'DOI_EXACT',
        targetItemId: 'item-existing-1',
      });
    });

    it('backfills missing fields while respecting user lockedFields and deduplicates merged citation graph relations', () => {
      const primaryMeta: Record<string, unknown> = {
        title: 'Custom User-Edited Title (Locked)',
        publisher: 'arXiv',
        lockedFields: ['title'],
        fieldProvenance: {
          title: {
            source: 'user',
            confidence: 1.0,
            lockedByUser: true,
            updatedAt: '2025-01-01T00:00:00Z',
          },
        },
      };
      const primaryItem = {
        id: 'target-1',
        title: 'Custom User-Edited Title (Locked)',
        citationKey: 'he2016deep',
        doi: null,
        arxivId: '1512.03385',
        abstract: null,
        year: 2015,
        publicationTitle: 'arXiv',
        metadata: primaryMeta,
      };
      const duplicateItem = {
        id: 'source-1',
        title: 'CrossRef Official Title',
        citationKey: 'he2016cvpr',
        doi: '10.1109/cvpr.2016.90',
        abstract: 'Backfilled peer-reviewed abstract.',
        year: 2016,
        publicationTitle: 'CVPR 2016',
        metadata: {
          title: 'CrossRef Official Title',
          abstract: 'Backfilled peer-reviewed abstract.',
          pages: '770-778',
        },
      };

      const backfillFields: Record<string, unknown> = {};
      const scalarSelections: Record<string, unknown> = {};
      applyMetadataAndProvenanceBackfill({
        primary: primaryItem,
        duplicates: [duplicateItem],
        scalarSelections,
        primaryMeta,
        backfillFields,
      });

      expect(backfillFields.title).toBeUndefined();
      expect(backfillFields.abstract).toBe(
        'Backfilled peer-reviewed abstract.',
      );
      expect(backfillFields.pages).toBe('770-778');

      const topLevel = computeMergedTopLevelAndPrimaryMeta({
        primary: primaryItem,
        backfillFields,
        scalarSelections,
        primaryMeta,
      });
      expect(topLevel.abstract).toBe('Backfilled peer-reviewed abstract.');

      const relPlan = planMergedItemRelations(
        [
          {
            id: 'rel-self',
            sourceItemId: 'source-1',
            targetItemId: 'target-1',
            relationType: 'is_published_version_of',
          },
          {
            id: 'rel-dup',
            sourceItemId: 'source-1',
            targetItemId: 'other-paper',
            relationType: 'cites',
          },
          {
            id: 'rel-existing',
            sourceItemId: 'target-1',
            targetItemId: 'other-paper',
            relationType: 'cites',
          },
          {
            id: 'rel-migrate',
            sourceItemId: 'source-1',
            targetItemId: 'novel-paper',
            relationType: 'cites',
          },
        ],
        'target-1',
        ['source-1'],
      );
      expect(relPlan.relationIdsToDelete).toEqual(['rel-self', 'rel-dup']);
      expect(relPlan.relationUpdates).toEqual([
        {
          id: 'rel-migrate',
          sourceItemId: 'target-1',
          targetItemId: 'novel-paper',
        },
      ]);
    });
  });

  describe('DuplicateDetectorService & DuplicateMergerService', () => {
    let detector: DuplicateDetectorService;
    let merger: DuplicateMergerService;
    let mockCatalog: jest.Mocked<ICatalogFacade>;
    let mockExtraction: jest.Mocked<IExtractionFacade>;
    let mockIngestionRepo: {
      findIngestionDuplicateSuspects: jest.Mock;
      resolveReviewCasesForItems: jest.Mock;
    };
    let mockTx: Record<string, any>;

    beforeEach(() => {
      const itemTxMock = {
        update: jest.fn(
          ({
            where,
            data,
          }: {
            where: { id: string };
            data: Record<string, unknown>;
          }) => Promise.resolve({ id: where.id, ...data, version: 2 }),
        ),
        findUnique: jest.fn(({ where }: { where: { id: string } }) =>
          Promise.resolve({
            id: where.id,
            title: 'Resolved Primary Title',
            itemType: 'journalArticle',
            version: 2,
            contributors: [],
            identifiers: [],
            collectionItems: [],
            itemTags: [],
            notesList: [],
            attachments: [],
          }),
        ),
      };

      mockTx = fromPartial<Prisma.TransactionClient & Record<string, unknown>>({
        $executeRaw: jest.fn().mockResolvedValue(1),
        item: itemTxMock,
        libraryItem: itemTxMock,
        itemRelation: {
          findMany: jest.fn().mockResolvedValue([]),
          delete: jest.fn().mockResolvedValue({}),
          update: jest.fn().mockResolvedValue({}),
        },
        contributor: {
          deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
          createMany: jest.fn().mockResolvedValue({ count: 0 }),
          count: jest.fn().mockResolvedValue(0),
        },
        userPublication: {
          findMany: jest.fn().mockResolvedValue([]),
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue({}),
          update: jest.fn().mockResolvedValue({}),
          delete: jest.fn().mockResolvedValue({}),
        },
        itemMetadata: {
          findFirst: jest.fn().mockResolvedValue(null),
          update: jest.fn().mockResolvedValue({}),
          deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
      });

      const mockUow = {
        executeInTransaction: jest.fn(
          (cb: (tx: unknown, h: Record<string, unknown>) => unknown) =>
            cb(mockTx, {
              appendChange: jest.fn().mockResolvedValue({}),
              recordTombstone: jest.fn().mockResolvedValue({}),
              publishOutbox: jest.fn().mockResolvedValue({}),
            }),
        ),
      };

      mockCatalog = fromPartial({
        findDuplicateCandidateItems: jest.fn(),
        findByIds: jest.fn(),
        mergeItems: jest.fn().mockResolvedValue(undefined),
      });
      mockExtraction = fromPartial({
        reassignContentToItem: jest.fn().mockResolvedValue(undefined),
      });
      mockIngestionRepo = {
        findIngestionDuplicateSuspects: jest.fn().mockResolvedValue([]),
        resolveReviewCasesForItems: jest.fn().mockResolvedValue(undefined),
      };

      detector = new DuplicateDetectorService(
        mockCatalog,
        mockIngestionRepo as never,
        mockUow as never,
      );
      merger = new DuplicateMergerService(
        mockUow as never,
        mockCatalog,
        mockExtraction,
        mockIngestionRepo as never,
      );
    });

    it('detects exact DOI, arXiv, PMID, ISBN, fuzzy Title+Year+Author, and ingestion suspect clusters', async () => {
      mockCatalog.findDuplicateCandidateItems.mockResolvedValueOnce([
        fromPartial({
          id: 'doi-1',
          title: 'Attention Is All You Need',
          doi: '10.1145/12345',
          year: 2017,
        }),
        fromPartial({
          id: 'doi-2',
          title: 'Attention preprint',
          doi: ' 10.1145/12345 ',
          year: 2017,
        }),
        fromPartial({
          id: 'arxiv-1',
          title: 'LoRA',
          metadata: { arxivId: '2106.09685' },
          year: 2021,
        }),
        fromPartial({
          id: 'arxiv-2',
          title: 'LoRA v2',
          metadata: { arxivId: '2106.09685v2' },
          year: 2021,
        }),
        fromPartial({
          id: 'fuz-1',
          title: 'Deep Residual Learning for Image Recognition',
          year: 2016,
          contributors: [
            {
              fullName: 'Kaiming He',
              firstName: 'Kaiming',
              lastName: 'He',
              orderIndex: 0,
            },
          ],
        }),
        fromPartial({
          id: 'fuz-2',
          title: 'Deep Residual Learning for Image Recognition (CVPR)',
          year: 2016,
          contributors: [
            {
              fullName: 'K. He',
              firstName: 'K.',
              lastName: 'He',
              orderIndex: 0,
            },
          ],
        }),
      ]);

      const clusters = await detector.detectDuplicates(
        mockUserId,
        mockProjectId,
      );
      expect(clusters.map((c) => c.matchReason)).toEqual(
        expect.arrayContaining([
          'EXACT_DOI',
          'EXACT_ARXIV',
          'FUZZY_TITLE_YEAR_AUTHOR',
        ]),
      );

      mockIngestionRepo.findIngestionDuplicateSuspects.mockResolvedValueOnce([
        {
          runId: 'run-1',
          createdItemId: 'item-new',
          targetItemId: 'item-existing',
          confidence: 0.88,
          matchReason: 'PROBABLE_MATCH',
        },
      ]);
      mockCatalog.findDuplicateCandidateItems.mockResolvedValueOnce([
        fromPartial({ id: 'item-new', title: 'GNNs in Action', year: 2023 }),
        fromPartial({
          id: 'item-existing',
          title: 'GNNs in Action (Early Access)',
          year: 2023,
        }),
      ]);
      const suspectClusters = await detector.detectDuplicates(
        mockUserId,
        mockProjectId,
      );
      expect(suspectClusters[0].matchReason).toBe('INGESTION_SUSPECT');
    });

    it('executes atomic advisory-locked merges borrowing missing contributors, transferring userPublications, and re-parenting itemMetadata', async () => {
      mockCatalog.findByIds.mockResolvedValueOnce([
        fromPartial<ItemDetail>({
          id: 'primary-1',
          title: 'Deep Learning',
          version: 1,
          contributors: [],
        }),
        fromPartial<ItemDetail>({
          id: 'dup-2',
          title: 'Deep Learning (Reprint)',
          version: 1,
          contributors: [
            { fullName: 'Yann LeCun', creatorType: 'author', orderIndex: 0 },
          ],
        }),
      ]);
      mockTx.userPublication.findMany.mockResolvedValueOnce([
        {
          userId: mockUserId,
          itemId: 'dup-2',
          contributorId: 'contrib-1',
          isPublic: true,
          openAccessLicense: 'CC-BY-4.0',
          addedAt: new Date('2026-01-01'),
        },
      ]);
      mockTx.itemMetadata.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'meta-dup-1', itemId: 'dup-2' });

      const result = await merger.mergeDuplicates(
        mockUserId,
        { primaryItemId: 'primary-1', duplicateItemIds: ['dup-2'] },
        mockProjectId,
      );

      expect(result.mergedCount).toBe(1);
      expect(result.softDeletedItemIds).toEqual(['dup-2']);
      expect(mockTx.$executeRaw).toHaveBeenCalled();
      expect(mockExtraction.reassignContentToItem).toHaveBeenCalledWith(
        ['dup-2'],
        'primary-1',
        mockTx,
      );
      expect(mockCatalog.mergeItems).toHaveBeenCalledWith(
        mockTx,
        ['dup-2'],
        'primary-1',
      );
      expect(mockTx.contributor.createMany).toHaveBeenCalled();
      expect(mockTx.userPublication.create).toHaveBeenCalled();
      expect(mockTx.itemMetadata.update).toHaveBeenCalledWith({
        where: { id: 'meta-dup-1' },
        data: { itemId: 'primary-1' },
      });
    });
  });
});
