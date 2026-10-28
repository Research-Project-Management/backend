import { Prisma } from '@prisma/client';
import {
  hasConflictingPartOrSupplementMarkers,
  extractPartAndVolumeMarkers,
  calculateTitleSimilarity,
} from '@/modules/library/ingestion/domain/deduplication.domain';
import {
  DuplicateDetectorService,
  getEffectiveItemField,
} from '@/modules/library/ingestion/services/duplicate-detector.service';
import {
  SYSTEM_RESERVED_MERGE_KEYS,
  syncMergedContributors,
  applyMergedUpdatesAndClearDuplicateCitationKeyCollision,
} from '@/modules/library/ingestion/domain/duplicate-merge.domain';
import {
  MetadataAndCreatorBackfillMergeStep,
  DuplicateMergeStepContext,
} from '@/modules/library/ingestion/domain/duplicate-merge.steps';
import { DuplicateMergerService } from '@/modules/library/ingestion/services/duplicate-merger.service';
import { ItemTransformer } from '@/modules/library/catalog/domain/item.transformer';
import { TypesService } from '@/modules/library/catalog/services/types.service';
import type { ICatalogFacade, TransactionHelpers } from '@/modules/library/core';
import type { TransactionService } from '@/modules/library/sync';
import type { IngestionRepository } from '@/modules/library/ingestion/repositories/ingestion.repository';

describe('Gatekeeper GE3 Audit — Deduplication, Merge Guards & Round-Trip Item Type Conversion', () => {
  describe('Fix 1: hasConflictingPartOrSupplementMarkers & extractPartAndVolumeMarkers', () => {
    it('does NOT falsely match ordinary English article "a" after "study", "paper", or "experiment"', () => {
      const mainTitle = 'Deep Learning for Single-Cell Genomics';
      const subtitleStudyA =
        'Deep Learning for Single-Cell Genomics: In this study a novel architecture is evaluated';
      const subtitlePaperA =
        'Deep Learning for Single-Cell Genomics: In this paper a transformer model is introduced';
      const caseStudyA =
        'Deep Learning for Single-Cell Genomics — Case study: a multicenter benchmark';

      expect(extractPartAndVolumeMarkers(mainTitle)).toEqual([]);
      expect(extractPartAndVolumeMarkers(subtitleStudyA)).toEqual([]);
      expect(extractPartAndVolumeMarkers(subtitlePaperA)).toEqual([]);
      expect(extractPartAndVolumeMarkers(caseStudyA)).toEqual([]);

      expect(
        hasConflictingPartOrSupplementMarkers(mainTitle, subtitleStudyA),
      ).toBe(false);
      expect(
        hasConflictingPartOrSupplementMarkers(mainTitle, subtitlePaperA),
      ).toBe(false);
      expect(hasConflictingPartOrSupplementMarkers(mainTitle, caseStudyA)).toBe(
        false,
      );
    });

    it('normalizes Roman numerals (Part I <-> Part 1, Volume II <-> Volume 2) so equivalent part markers do not conflict', () => {
      expect(
        hasConflictingPartOrSupplementMarkers(
          'Foundations of Quantum Computing, Part I: Theory',
          'Foundations of Quantum Computing, Part 1: Theory',
        ),
      ).toBe(false);
      expect(
        hasConflictingPartOrSupplementMarkers(
          'Lectures on Statistical Mechanics, Vol. IV',
          'Lectures on Statistical Mechanics, Volume 4',
        ),
      ).toBe(false);
      expect(
        calculateTitleSimilarity(
          'Foundations of Quantum Computing, Part I',
          'Foundations of Quantum Computing, Part 1',
        ),
      ).toBeGreaterThan(0.95);
    });

    it('still blocks genuinely distinct multi-part papers (Part I vs Part II, Volume 1 vs Volume 2, Part A vs Part B)', () => {
      expect(
        hasConflictingPartOrSupplementMarkers(
          'Foundations of Quantum Computing, Part I',
          'Foundations of Quantum Computing, Part II',
        ),
      ).toBe(true);
      expect(
        hasConflictingPartOrSupplementMarkers(
          'Linear Systems, Volume 1',
          'Linear Systems, Volume 2',
        ),
      ).toBe(true);
      expect(
        hasConflictingPartOrSupplementMarkers(
          'Standardized Clinical Protocol: Part A',
          'Standardized Clinical Protocol: Part B',
        ),
      ).toBe(true);
    });
  });

  describe('Fix 2: Tier 0/1/2 Duplicate Detection Guards & Preprint Evolution', () => {
    it('2A: allows bookSection items with identical DOI even if subtitle lowers titleSim < 0.78, and normalizes ISBN volume/edition tokens', () => {
      const detector = new DuplicateDetectorService();

      const chapterShort = {
        id: 'ch-doi-1',
        title: 'Backpropagation in Deep Networks',
        itemType: 'bookSection',
        doi: '10.1007/978-3-030-12345-6_4',
        metadata: { pages: '45-60' },
      };
      const chapterWithSubtitle = {
        id: 'ch-doi-2',
        title:
          'Backpropagation in Deep Networks: Historical Perspectives, Mathematical Derivations, and Practical Implementation Details',
        itemType: 'bookSection',
        doi: '10.1007/978-3-030-12345-6_4',
        metadata: { pages: '1-16' },
      };

      expect(
        detector.areCompatibleIdentifierDuplicates(
          chapterShort as never,
          chapterWithSubtitle as never,
          'doi',
        ),
      ).toBe(true);

      const bookA = {
        id: 'book-1',
        title: 'Pattern Recognition and Machine Learning',
        itemType: 'book',
        isbn: '978-0-387-31073-2',
        metadata: { edition: '2nd ed.', volume: 'Vol. 1' },
      };
      const bookB = {
        id: 'book-2',
        title: 'Pattern Recognition and Machine Learning',
        itemType: 'book',
        isbn: '9780387310732',
        metadata: { edition: '2', volume: '1' },
      };
      const bookDiffEd = {
        id: 'book-3',
        title: 'Pattern Recognition and Machine Learning',
        itemType: 'book',
        isbn: '9780387310732',
        metadata: { edition: '3rd Edition', volume: '1' },
      };

      expect(
        detector.areCompatibleIdentifierDuplicates(
          bookA as never,
          bookB as never,
          'isbn',
        ),
      ).toBe(true);
      expect(
        detector.areCompatibleIdentifierDuplicates(
          bookA as never,
          bookDiffEd as never,
          'isbn',
        ),
      ).toBe(false);
    });

    it('2B & 2C: recognizes SSRN/Zenodo/OSF/TechRxiv/ResearchGate preprint DOIs, allows cross-server preprints, normalizes issue ("04" vs "No. 4"), allows PDF 1-N or electronic pages vs journal pages, and allows 3-year preprint evolution window', async () => {
      const candidates = [
        // Pair 1: bioRxiv preprint (2021) + Nature published article (2024) — 3-year gap
        {
          id: 'biorxiv-2021',
          title: 'Single-Cell Multiomic Atlas of Human Brain Development',
          itemType: 'journalArticle',
          doi: '10.1101/2021.04.12.439501',
          year: 2021,
          authors: ['Kriegstein, Arnold R.'],
          publicationTitle: 'bioRxiv',
          metadata: {},
        },
        {
          id: 'nature-2024',
          title: 'Single-Cell Multiomic Atlas of Human Brain Development',
          itemType: 'journalArticle',
          doi: '10.1038/s41586-024-07123-4',
          year: 2024,
          authors: ['Arnold R. Kriegstein'],
          publicationTitle: 'Nature',
          metadata: { volume: '628', issue: '04', pages: '245-262' },
        },
        // Pair 2: Cross-server preprints (SSRN DOI + arXiv DOI)
        {
          id: 'ssrn-preprint',
          title: 'Algorithmic Collusion in Decentralized Financial Markets',
          itemType: 'preprint',
          doi: '10.2139/ssrn.4123456',
          year: 2023,
          authors: ['Acemoglu, Daron'],
          metadata: { repository: 'SSRN' },
        },
        {
          id: 'arxiv-preprint',
          title: 'Algorithmic Collusion in Decentralized Financial Markets',
          itemType: 'preprint',
          doi: '10.48550/arXiv.2305.54321',
          arxivId: '2305.54321',
          year: 2023,
          authors: ['Daron Acemoglu'],
          metadata: { repository: 'arXiv' },
        },
        // Pair 3: Published article with PDF local pages "1-18" & issue "04" vs journal pages "245-262" & issue "No. 4"
        {
          id: 'pdf-local-pages',
          title: 'Federated Optimization Under Byzantine Client Corruptions',
          itemType: 'journalArticle',
          year: 2024,
          authors: ['Jordan, Michael I.'],
          metadata: { issue: '04', pages: '1-18' },
        },
        {
          id: 'journal-issue-pages',
          title: 'Federated Optimization Under Byzantine Client Corruptions',
          itemType: 'journalArticle',
          year: 2024,
          authors: ['Michael I. Jordan'],
          metadata: { issue: 'No. 4', pages: '245-262' },
        },
      ];

      const mockCatalog: Partial<ICatalogFacade> = {
        findDuplicateCandidateItems: jest.fn(async () => candidates as never),
        findByIds: jest.fn(async () => []),
      };
      const detector = new DuplicateDetectorService(
        mockCatalog as ICatalogFacade,
      );

      const clusters = await detector.detectDuplicates('user-1');
      expect(clusters).toHaveLength(3);

      const clusterIdSets = clusters.map((c) =>
        c.items.map((i) => i.id).sort(),
      );
      expect(clusterIdSets).toEqual(
        expect.arrayContaining([
          ['biorxiv-2021', 'nature-2024'],
          ['arxiv-preprint', 'ssrn-preprint'],
          ['journal-issue-pages', 'pdf-local-pages'],
        ]),
      );

      // Verify genuine page conflict ("101-110" vs "205-215") in same issue is STILL blocked
      expect(
        detector.hasConflictingTier2BibliographicEvidence(
          {
            id: 'p1',
            title: 'Quantum Error Correction',
            year: 2024,
            metadata: { issue: '4', pages: '101-110' },
          } as never,
          {
            id: 'p2',
            title: 'Quantum Error Correction',
            year: 2024,
            metadata: { issue: '4', pages: '205-215' },
          } as never,
        ),
      ).toBe(true);
    });

    it('2D: absorbs 3rd duplicate sharing exact DOI into existing Tier 0 INGESTION_SUSPECT cluster instead of starving it', async () => {
      const candidates = [
        {
          id: 'item-1',
          title: 'Scaling Language Models',
          itemType: 'journalArticle',
          doi: '10.1038/s41586-024-00001-1',
          year: 2024,
          authors: ['Rae, Jack'],
          metadata: {},
        },
        {
          id: 'item-2',
          title: 'Scaling Language Models',
          itemType: 'journalArticle',
          doi: '10.1038/s41586-024-00001-1',
          year: 2024,
          authors: ['Rae, Jack'],
          metadata: {},
        },
        {
          id: 'item-3-third-copy',
          title: 'Scaling Language Models: Methods and Systems',
          itemType: 'journalArticle',
          doi: '10.1038/s41586-024-00001-1',
          year: 2024,
          authors: ['Rae, Jack'],
          metadata: {},
        },
      ];

      const mockCatalog: Partial<ICatalogFacade> = {
        findDuplicateCandidateItems: jest.fn(async () => candidates as never),
        findByIds: jest.fn(async () => []),
      };
      const mockIngestionRepo: Partial<IngestionRepository> = {
        findIngestionDuplicateSuspects: jest.fn(async () => [
          {
            runId: 'run-12345678',
            createdItemId: 'item-1',
            targetItemId: 'item-2',
            confidence: 0.95,
          },
        ]) as never,
      };

      const detector = new DuplicateDetectorService(
        mockCatalog as ICatalogFacade,
        mockIngestionRepo as IngestionRepository,
      );

      const clusters = await detector.detectDuplicates('user-1');
      expect(clusters).toHaveLength(1);
      expect(clusters[0].matchReason).toBe('INGESTION_SUSPECT');
      expect(clusters[0].items.map((i) => i.id).sort()).toEqual([
        'item-1',
        'item-2',
        'item-3-third-copy',
      ]);
    });
  });

  describe('Fix 3: MetadataAndCreatorBackfillMergeStep, syncMergedContributors & SYSTEM_RESERVED_MERGE_KEYS', () => {
    it('3A: backfills full ISO date and bookTitle/proceedingsTitle even when primary has year or publicationTitle, and upgrades preprint publicationTitle to peer-reviewed journal', async () => {
      const step = new MetadataAndCreatorBackfillMergeStep();
      const mockTx = {
        contributor: {
          count: jest.fn().mockResolvedValue(1),
          deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
          createMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
        item: {
          update: jest.fn().mockResolvedValue({}),
        },
      } as unknown as Prisma.TransactionClient;

      const primary = {
        id: 'primary-1',
        title: ' Neural Scaling Laws ',
        year: 2024,
        publicationTitle: 'arXiv',
        metadata: {
          publicationTitle: 'arXiv',
          fieldProvenance: {
            publicationTitle: {
              source: 'arXiv',
              confidence: 0.85,
            },
          },
        },
      };

      const donor = {
        id: 'donor-1',
        title: 'Neural Scaling Laws',
        year: 2024,
        publicationTitle: 'Journal of Machine Learning Research',
        metadata: {
          date: '2024-05-15',
          publicationDate: '2024-05-15',
          bookTitle: 'Advances in Neural Information Processing',
          proceedingsTitle: 'Proceedings of ICML 2024',
          journal: 'Journal of Machine Learning Research',
          fieldProvenance: {
            publicationTitle: {
              source: 'CrossRef',
              confidence: 0.95,
            },
            journal: {
              source: 'CrossRef',
              confidence: 0.95,
            },
          },
        },
      };

      expect(
        getEffectiveItemField(primary, 'date', primary.metadata, {
          excludeGenericsFromSpecificTarget: true,
        }),
      ).toBeUndefined();
      expect(
        getEffectiveItemField(primary, 'bookTitle', primary.metadata, {
          excludeGenericsFromSpecificTarget: true,
        }),
      ).toBeUndefined();

      const primaryMeta: Record<string, unknown> = { ...primary.metadata };
      const backfillFields: Record<string, unknown> = {};
      const ctx: DuplicateMergeStepContext = {
        tx: mockTx,
        primary,
        duplicates: [donor],
        uniqueDupIds: ['donor-1'],
        rawSelections: {},
        scalarSelections: {},
        primaryMeta,
        backfillFields,
        offloadedFileIdsToDelete: [],
        now: new Date('2025-01-01T00:00:00.000Z'),
      };

      await step.execute(ctx);

      expect(backfillFields.date).toBe('2024-05-15');
      expect(backfillFields.bookTitle).toBe(
        'Advances in Neural Information Processing',
      );
      expect(backfillFields.proceedingsTitle).toBe('Proceedings of ICML 2024');
      expect(backfillFields.publicationTitle).toBe(
        'Journal of Machine Learning Research',
      );

      const { topLevelData } =
        await applyMergedUpdatesAndClearDuplicateCitationKeyCollision({
          tx: mockTx,
          primary,
          duplicates: [donor],
          effectiveMergedItemType: 'journalArticle',
          derivedFirstAuthor: 'Kaplan',
          noteCount: 0,
          attachmentCount: 0,
          backfillFields,
          scalarSelections: {},
          primaryMeta,
        });

      expect(topLevelData.publicationTitle).toBe(
        'Journal of Machine Learning Research',
      );
      expect(primaryMeta.date).toBe('2024-05-15');
    });

    it('3B: allows explicit empty array chosenContributors = [] to clear contributors, and upgrades noisy PDF contributors when high-authority CrossRef donor has fewer but cleaner authors', async () => {
      const mockTx = {
        contributor: {
          count: jest.fn().mockResolvedValue(3),
          deleteMany: jest.fn().mockResolvedValue({ count: 3 }),
          createMany: jest.fn().mockResolvedValue({ count: 2 }),
        },
      } as unknown as Prisma.TransactionClient;

      const primaryMetaClear: Record<string, unknown> = {
        creators: [{ firstName: 'Old', lastName: 'Author' }],
        authors: ['Old Author'],
      };

      const cleared = await syncMergedContributors(
        mockTx,
        'primary-clear',
        [],
        [
          {
            contributors: [{ firstName: 'Donor', lastName: 'Author' }],
          },
        ],
        {
          contributors: [{ firstName: 'Old', lastName: 'Author' }],
        },
        primaryMetaClear,
      );

      expect(cleared).toEqual([]);
      expect(primaryMetaClear.creators).toEqual([]);
      expect(primaryMetaClear.authors).toEqual([]);

      // High-authority CrossRef donor with 2 clean authors replaces noisy PDF extraction with 3 authors
      const noisyPdfPrimary = {
        id: 'primary-pdf',
        contributors: [
          { firstName: 'Alice', lastName: 'Smith' },
          { firstName: 'Bob', lastName: 'Jones' },
          { firstName: '', lastName: 'Department of Physics' },
        ],
        metadata: {
          source: 'LocalPDFExtraction',
          fieldProvenance: {
            creators: { source: 'LocalPDFExtraction', confidence: 0.7 },
          },
        },
      };
      const cleanCrossrefDup = {
        id: 'dup-crossref',
        contributors: [
          { firstName: 'Alice M.', lastName: 'Smith' },
          { firstName: 'Robert', lastName: 'Jones' },
        ],
        metadata: {
          source: 'CrossRef',
          fieldProvenance: {
            creators: { source: 'CrossRef', confidence: 0.98 },
          },
        },
      };
      const primaryMetaUpgrade: Record<string, unknown> = {};

      const upgraded = await syncMergedContributors(
        mockTx,
        'primary-pdf',
        undefined,
        [cleanCrossrefDup],
        noisyPdfPrimary,
        primaryMetaUpgrade,
      );

      expect(upgraded).toHaveLength(2);
      expect(primaryMetaUpgrade.authors).toEqual([
        'Alice M. Smith',
        'Robert Jones',
      ]);
    });

    it('3C: blocks system-reserved and retraction/provenance keys in SYSTEM_RESERVED_MERGE_KEYS during mergeDuplicates', async () => {
      const reservedSamples = [
        'attachmentCount',
        'noteCount',
        'hasFile',
        'normalizedTitle',
        'searchVector',
        'firstAuthor',
        'isRetracted',
        'retraction',
        'retractionDate',
        'retractionNature',
        'retractionDetails',
        'retractionCheckedAt',
        'retractionReasons',
        'retractionNoticeDoi',
        'retractionSource',
        'mergeHistory',
        'fieldProvenance',
        'lockedFields',
        'dismissedDuplicateIds',
        'mergedCitationKeys',
        '__proto__',
        'constructor',
        'prototype',
      ];

      for (const key of reservedSamples) {
        expect(SYSTEM_RESERVED_MERGE_KEYS.has(key)).toBe(true);
      }

      const merger = new DuplicateMergerService(
        {
          executeInTransaction: jest.fn(),
        } as unknown as TransactionService,
        {
          findByIds: jest.fn(),
        } as unknown as ICatalogFacade,
      );

      await expect(
        merger.mergeDuplicates('user-1', {
          primaryItemId: 'item-1',
          duplicateItemIds: ['item-2'],
          fieldSelections: {
            isRetracted: false,
          },
        }),
      ).rejects.toThrow(/system-reserved key/i);
    });
  });

  describe('Fix 4: Round-Trip Item Type Conversion (journalArticle -> webpage -> journalArticle)', () => {
    it('restores volume, issue, and pages from __unmapped_journalArticle_* and cleans up newExtraFields and projectedItem.extra on round-trip conversion', () => {
      const typesService = new TypesService();
      const transformer = new ItemTransformer(typesService);

      const originalArticle = {
        id: 'item-rt-1',
        itemType: 'journalArticle',
        title: 'Attention Is All You Need',
        publicationTitle: 'Journal of Machine Learning Research',
        volume: '25',
        issue: '4',
        pages: '100-142',
        doi: '10.1000/jmlr.2024.100',
        year: 2024,
        creators: [
          {
            creatorType: 'author',
            firstName: 'Ashish',
            lastName: 'Vaswani',
          },
        ],
      };

      const toWebpage = transformer.previewConversion(
        originalArticle,
        'webpage',
      );
      expect(toWebpage.projectedItem.itemType).toBe('webpage');
      expect(toWebpage.projectedItem.websiteTitle).toBe(
        'Journal of Machine Learning Research',
      );
      const webpageEf = toWebpage.projectedItem.extraFields as Record<
        string,
        unknown
      >;
      expect(webpageEf.__unmapped_journalArticle_volume).toBe('25');
      expect(webpageEf.__unmapped_journalArticle_issue).toBe('4');
      expect(webpageEf.__unmapped_journalArticle_pages).toBe('100-142');
      expect(String(toWebpage.projectedItem.extra)).toContain('Volume: 25');
      expect(String(toWebpage.projectedItem.extra)).toContain('Issue: 4');
      expect(String(toWebpage.projectedItem.extra)).toContain('Pages: 100-142');

      const backToJournal = transformer.previewConversion(
        toWebpage.projectedItem,
        'journalArticle',
      );
      expect(backToJournal.projectedItem.itemType).toBe('journalArticle');
      expect(backToJournal.projectedItem.publicationTitle).toBe(
        'Journal of Machine Learning Research',
      );
      expect(backToJournal.projectedItem.volume).toBe('25');
      expect(backToJournal.projectedItem.issue).toBe('4');
      expect(backToJournal.projectedItem.pages).toBe('100-142');

      const restoredEf = backToJournal.projectedItem.extraFields as Record<
        string,
        unknown
      >;
      expect(restoredEf.__unmapped_journalArticle_volume).toBeUndefined();
      expect(restoredEf.__unmapped_journalArticle_issue).toBeUndefined();
      expect(restoredEf.__unmapped_journalArticle_pages).toBeUndefined();
      expect(String(backToJournal.projectedItem.extra || '')).not.toContain(
        'Volume: 25',
      );
      expect(String(backToJournal.projectedItem.extra || '')).not.toContain(
        'Issue: 4',
      );
      expect(String(backToJournal.projectedItem.extra || '')).not.toContain(
        'Pages: 100-142',
      );
    });
  });
});
