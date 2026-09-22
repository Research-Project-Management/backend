import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { fromPartial } from '@total-typescript/shoehorn';
import { Prisma } from '@prisma/client';
import { DuplicateService } from '@/modules/library/ingestion/application/services/duplicate.service';
import { PrismaService } from '@/core/database/prisma.service';
import {
  TransactionService,
  TransactionHelpers,
} from '@/modules/library/shared-kernel/outbox/transaction.service';
import {
  BIBLIOGRAPHY_FACADE,
  IBibliographyFacade,
} from '@/modules/library/bibliography/bibliography.facade';
import {
  READER_FACADE,
  IReaderFacade,
} from '@/modules/library/reader/reader.facade';
import { IngestionRepository } from '@/modules/library/ingestion/infrastructure/repositories/ingestion.repository';
import { ItemDetail } from '@/modules/library/bibliography/domain/ports/items.ports';
import {
  normalizeTitleForDedupe,
  extractFirstAuthorFamily,
  generateDedupeBucketKey,
} from '@/modules/library/ingestion/application/utils/curation.utils';

describe('Library Curation — Deduplication Engine & Auto-Resolver Suite', () => {
  const mockUserId = '11111111-1111-4111-8111-111111111111';
  const mockProjectId = '22222222-2222-4222-8222-222222222222';

  describe('Curation Utilities & Fingerprinting', () => {
    it('should normalize titles removing punctuation, articles, and extra spaces', () => {
      expect(normalizeTitleForDedupe('The Attention Is All You Need!')).toBe(
        'theattentionisallyouneed',
      );
      expect(normalizeTitleForDedupe('A Deep-Learning Study: On LLMs...')).toBe(
        'adeeplearningstudyonllms',
      );
    });

    it('should extract first author family name correctly', () => {
      expect(extractFirstAuthorFamily(['Vaswani, Ashish'])).toBe('vaswani');
      expect(extractFirstAuthorFamily(['Geoffrey E. Hinton'])).toBe('hinton');
      expect(extractFirstAuthorFamily([])).toBe('');
      expect(extractFirstAuthorFamily(null)).toBe('');
    });

    it('should generate robust deduplication bucket keys', () => {
      const key = generateDedupeBucketKey(
        'Deep Residual Learning for Image Recognition',
        ['He, Kaiming'],
      );
      expect(key).toBe('deepresiduallearningforimagereco::he');
    });
  });

  describe('DuplicateService (Detection, Advisory Lock, & Auto-Cluster Resolution)', () => {
    let service: DuplicateService;
    let mockPrisma: any;
    let mockLibraryTx: any;
    let mockBibliographyFacade: jest.Mocked<IBibliographyFacade>;
    let mockReaderFacade: jest.Mocked<IReaderFacade>;
    let mockTx: any;
    let mockHelpers: jest.Mocked<TransactionHelpers>;
    let mockIngestionRepo: any;

    beforeEach(async () => {
      mockHelpers = {
        appendChange: jest.fn().mockResolvedValue(fromPartial({})),
        recordTombstone: jest.fn().mockResolvedValue(fromPartial({})),
        publishOutbox: jest.fn().mockResolvedValue(fromPartial({})),
      };

      mockTx = fromPartial<Prisma.TransactionClient>({
        $executeRaw: jest.fn().mockResolvedValue(1),
        item: fromPartial({
          update: jest
            .fn()
            .mockImplementation(({ where, data }) =>
              Promise.resolve({ id: where.id, ...data, version: 2 }),
            ),
          findUnique: jest.fn().mockImplementation(({ where }) =>
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
        }),
        itemRelation: fromPartial({
          findMany: jest.fn().mockResolvedValue([]),
          delete: jest.fn().mockResolvedValue({}),
          update: jest.fn().mockResolvedValue({}),
        }),
        contributor: fromPartial({
          deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
          createMany: jest.fn().mockResolvedValue({ count: 0 }),
          count: jest.fn().mockResolvedValue(0),
        }),
        userPublication: fromPartial({
          findMany: jest.fn().mockResolvedValue([]),
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue({}),
          update: jest.fn().mockResolvedValue({}),
          delete: jest.fn().mockResolvedValue({}),
        }),
        itemMetadata: fromPartial({
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        }),
      });

      mockLibraryTx = {
        executeInTransaction: jest
          .fn()
          .mockImplementation((cb: any) => cb(mockTx, mockHelpers)),
      };

      mockBibliographyFacade = fromPartial({
        findDuplicateCandidateItems: jest.fn(),
        findByIds: jest.fn(),
        mergeItems: jest.fn().mockResolvedValue(undefined),
      });
      mockReaderFacade = fromPartial({
        reassignContentToItem: jest.fn().mockResolvedValue(undefined),
      });
      mockIngestionRepo = fromPartial({
        findIngestionDuplicateSuspects: jest.fn().mockResolvedValue([]),
        resolveReviewCasesForItems: jest.fn().mockResolvedValue(undefined),
      });
      mockPrisma = fromPartial({});

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          DuplicateService,
          { provide: PrismaService, useValue: mockPrisma },
          { provide: TransactionService, useValue: mockLibraryTx },
          { provide: BIBLIOGRAPHY_FACADE, useValue: mockBibliographyFacade },
          { provide: READER_FACADE, useValue: mockReaderFacade },
          { provide: IngestionRepository, useValue: mockIngestionRepo },
        ],
      }).compile();

      service = module.get<DuplicateService>(DuplicateService);
    });

    it('should detect duplicate items via exact normalized DOI', async () => {
      mockBibliographyFacade.findDuplicateCandidateItems.mockResolvedValueOnce([
        fromPartial({
          id: 'item-1',
          title: 'Attention Is All You Need',
          doi: '10.1145/12345',
          year: 2017,
        }),
        fromPartial({
          id: 'item-2',
          title: 'Attention is all you need - preprint',
          doi: ' 10.1145/12345 ',
          year: 2017,
        }),
      ]);

      const clusters = await service.detectDuplicates(
        mockUserId,
        mockProjectId,
      );
      expect(clusters).toHaveLength(1);
      expect(clusters[0].matchReason).toBe('EXACT_DOI');
      expect(clusters[0].confidence).toBe(1.0);
      expect(clusters[0].items).toHaveLength(2);
    });

    it('should detect duplicate items via fuzzy Title + Year + Author matching', async () => {
      mockBibliographyFacade.findDuplicateCandidateItems.mockResolvedValueOnce([
        fromPartial({
          id: 'item-a',
          title: 'Deep Residual Learning for Image Recognition',
          year: 2016,
          doi: null,
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
          id: 'item-b',
          title: 'Deep Residual Learning for Image Recognition (CVPR)',
          year: 2016,
          doi: null,
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

      const clusters = await service.detectDuplicates(
        mockUserId,
        mockProjectId,
      );
      expect(clusters).toHaveLength(1);
      expect(clusters[0].matchReason).toBe('FUZZY_TITLE_YEAR_AUTHOR');
      expect(clusters[0].confidence).toBe(0.85);
      expect(clusters[0].items).toHaveLength(2);
    });

    it('should detect duplicate items via exact arXiv ID', async () => {
      mockBibliographyFacade.findDuplicateCandidateItems.mockResolvedValueOnce([
        fromPartial({
          id: 'item-arxiv-1',
          title: 'LoRA: Low-Rank Adaptation of Large Language Models',
          metadata: { arxivId: '2106.09685' },
          year: 2021,
        }),
        fromPartial({
          id: 'item-arxiv-2',
          title: 'LoRA preprint',
          metadata: { arxivId: '2106.09685v2' },
          year: 2021,
        }),
      ]);

      const clusters = await service.detectDuplicates(
        mockUserId,
        mockProjectId,
      );
      expect(clusters).toHaveLength(1);
      expect(clusters[0].matchReason).toBe('EXACT_ARXIV');
      expect(clusters[0].confidence).toBe(1.0);
      expect(clusters[0].items).toHaveLength(2);
    });

    it('should detect duplicate items via exact PMID and ISBN', async () => {
      mockBibliographyFacade.findDuplicateCandidateItems.mockResolvedValueOnce([
        fromPartial({
          id: 'item-pmid-1',
          title: 'CRISPR-Cas9 structures',
          metadata: { pmid: '24507850' },
          year: 2014,
        }),
        fromPartial({
          id: 'item-pmid-2',
          title: 'CRISPR Cas9 structural biology',
          metadata: { pmid: ' 24507850 ' },
          year: 2014,
        }),
        fromPartial({
          id: 'item-isbn-1',
          title: 'Clean Code',
          metadata: { isbn: '978-0-13-235088-4' },
          year: 2008,
        }),
        fromPartial({
          id: 'item-isbn-2',
          title: 'Clean Code: A Handbook',
          metadata: { isbn: '9780132350884' },
          year: 2008,
        }),
      ]);

      const clusters = await service.detectDuplicates(
        mockUserId,
        mockProjectId,
      );
      expect(clusters).toHaveLength(2);
      expect(clusters.some((c) => c.matchReason === 'EXACT_PMID')).toBe(true);
      expect(clusters.some((c) => c.matchReason === 'EXACT_ISBN')).toBe(true);
    });

    it('should detect ingestion suspect pairs flagged during pipeline execution', async () => {
      mockIngestionRepo.findIngestionDuplicateSuspects.mockResolvedValueOnce([
        {
          runId: 'run-12345678',
          createdItemId: 'item-new',
          targetItemId: 'item-existing',
          confidence: 0.88,
          matchReason: 'PROBABLE_MATCH',
        },
      ]);

      mockBibliographyFacade.findDuplicateCandidateItems.mockResolvedValueOnce([
        fromPartial({
          id: 'item-new',
          title: 'Graph Neural Networks in Action',
          year: 2023,
        }),
        fromPartial({
          id: 'item-existing',
          title: 'Graph Neural Networks in Action (Early Access)',
          year: 2023,
        }),
      ]);

      const clusters = await service.detectDuplicates(
        mockUserId,
        mockProjectId,
      );
      expect(clusters).toHaveLength(1);
      expect(clusters[0].matchReason).toBe('INGESTION_SUSPECT');
      expect(clusters[0].confidence).toBe(0.88);
      expect(clusters[0].items).toHaveLength(2);
    });

    it('should borrow contributors from donor during merge when primary is missing authors', async () => {
      const primaryItem = fromPartial<ItemDetail>({
        id: 'primary-no-authors',
        title: 'Deep Learning without authors',
        version: 1,
        contributors: [],
      });
      const duplicateItem = fromPartial<ItemDetail>({
        id: 'dup-with-authors',
        title: 'Deep Learning',
        version: 1,
        contributors: [
          {
            fullName: 'Yann LeCun',
            creatorType: 'author',
            orderIndex: 0,
          },
        ],
      });

      mockBibliographyFacade.findByIds.mockResolvedValueOnce([
        primaryItem,
        duplicateItem,
      ]);

      await service.mergeDuplicates(
        mockUserId,
        {
          primaryItemId: 'primary-no-authors',
          duplicateItemIds: ['dup-with-authors'],
          projectId: mockProjectId,
        },
        mockProjectId,
      );

      // Verify contributors were copied to primary item
      expect(mockTx.contributor.createMany).toHaveBeenCalledWith({
        data: expect.arrayContaining([
          expect.objectContaining({
            itemId: 'primary-no-authors',
            fullName: 'Yann LeCun',
          }),
        ]),
      });
    });

    it('should acquire pg_advisory_xact_lock and execute merge atomically', async () => {
      const primaryItem = fromPartial<ItemDetail>({
        id: 'primary-1',
        title: 'Deep Learning',
        version: 1,
        citationKey: 'lecun2015',
        extra: null,
      });
      const duplicateItem = fromPartial<ItemDetail>({
        id: 'dup-2',
        title: 'Deep Learning (Reprint)',
        version: 1,
        citationKey: 'lecun2015deep',
        extra: null,
      });

      mockBibliographyFacade.findByIds.mockResolvedValueOnce([
        primaryItem,
        duplicateItem,
      ]);

      const result = await service.mergeDuplicates(
        mockUserId,
        {
          primaryItemId: 'primary-1',
          duplicateItemIds: ['dup-2'],
          projectId: mockProjectId,
        },
        mockProjectId,
      );

      // Verify advisory transaction lock was acquired
      expect(mockTx.$executeRaw).toHaveBeenCalled();
      // Verify facades were orchestrated
      expect(mockReaderFacade.reassignContentToItem).toHaveBeenCalledWith(
        ['dup-2'],
        'primary-1',
        mockTx,
      );
      expect(mockBibliographyFacade.mergeItems).toHaveBeenCalledWith(
        mockTx,
        ['dup-2'],
        'primary-1',
      );

      // Verify duplicate was soft-deleted with merge marker
      expect(mockTx.item.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'dup-2' },
          data: expect.objectContaining({
            deletedAt: expect.any(Date),
            metadata: expect.objectContaining({
              mergedIntoId: 'primary-1',
            }),
          }),
        }),
      );

      expect(result.mergedCount).toBe(1);
      expect(result.softDeletedItemIds).toEqual(['dup-2']);
    });

    it('should auto-resolve cluster using "most_complete" strategy and borrow missing fields', async () => {
      // 1. Setup candidate items in detectDuplicates
      mockBibliographyFacade.findDuplicateCandidateItems.mockResolvedValue([
        fromPartial({
          id: 'item-incomplete',
          title: 'Quantum Computing',
          doi: '10.1000/182',
          year: 2021,
        }),
        fromPartial({
          id: 'item-complete',
          title: 'Quantum Computing: A Gentle Introduction',
          doi: '10.1000/182',
          year: 2021,
        }),
      ]);

      // 2. Setup candidate items fetched by bibliographyFacade.findByIds for ranking & merge
      const itemIncomplete = fromPartial<ItemDetail>({
        id: 'item-incomplete',
        title: 'Quantum Computing',
        doi: '10.1000/182',
        year: 2021,
        abstract: null,
        url: null,
        publisher: null,
        contributors: [],
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
      });

      const itemComplete = fromPartial<ItemDetail>({
        id: 'item-complete',
        title: 'Quantum Computing: A Gentle Introduction',
        doi: '10.1000/182',
        year: 2021,
        abstract: 'A comprehensive study of quantum computing principles.',
        url: 'https://example.com/paper.pdf',
        publisher: 'MIT Press',
        contributors: [
          {
            fullName: 'Eleanor Rieffel',
            firstName: 'Eleanor',
            lastName: 'Rieffel',
            orderIndex: 0,
          },
        ],
        createdAt: new Date('2026-01-02'),
        updatedAt: new Date('2026-01-02'),
      });

      // First call for ranking in autoResolveCluster, second call inside mergeDuplicates
      mockBibliographyFacade.findByIds
        .mockResolvedValueOnce([itemIncomplete, itemComplete])
        .mockResolvedValueOnce([itemComplete, itemIncomplete]);

      const clusters = await service.detectDuplicates(
        mockUserId,
        mockProjectId,
      );
      const clusterId = clusters[0].clusterId;

      const result = await service.autoResolveCluster(
        mockUserId,
        clusterId,
        'most_complete',
        mockProjectId,
      );

      expect(result.mergedCount).toBe(1);
      expect(result.softDeletedItemIds).toEqual(['item-incomplete']);
    });

    it('should throw NotFoundException if clusterId does not exist during autoResolveCluster', async () => {
      mockBibliographyFacade.findDuplicateCandidateItems.mockResolvedValueOnce([]);

      await expect(
        service.autoResolveCluster(mockUserId, 'non-existent-cluster'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if cluster contains fewer than 2 items to merge', async () => {
      mockBibliographyFacade.findDuplicateCandidateItems.mockResolvedValue([
        fromPartial({ id: 'item-1', doi: '10.1/1', title: 'Paper 1' }),
        fromPartial({ id: 'item-2', doi: '10.1/1', title: 'Paper 2' }),
      ]);

      // simulate only 1 item remaining in DB (one already deleted)
      mockBibliographyFacade.findByIds.mockResolvedValueOnce([
        fromPartial<ItemDetail>({
          id: 'item-1',
          doi: '10.1/1',
          title: 'Paper 1',
        }),
      ]);

      const clusters = await service.detectDuplicates(mockUserId);
      await expect(
        service.autoResolveCluster(mockUserId, clusters[0].clusterId),
      ).rejects.toThrow(BadRequestException);
    });

    it('should transfer user_publications to primary item and delete duplicate publications', async () => {
      const primaryItem = fromPartial<ItemDetail>({
        id: 'primary-pub-item',
        title: 'Primary Publication',
        version: 1,
      });
      const duplicateItem = fromPartial<ItemDetail>({
        id: 'dup-pub-item',
        title: 'Duplicate Publication',
        version: 1,
      });

      mockBibliographyFacade.findByIds.mockResolvedValueOnce([
        primaryItem,
        duplicateItem,
      ]);

      mockTx.userPublication.findMany.mockResolvedValueOnce([
        {
          userId: mockUserId,
          itemId: 'dup-pub-item',
          contributorId: 'contrib-123',
          isPublic: true,
          openAccessLicense: 'CC-BY-4.0',
          addedAt: new Date('2026-01-01'),
        },
      ]);
      mockTx.userPublication.findUnique.mockResolvedValueOnce(null);

      await service.mergeDuplicates(
        mockUserId,
        {
          primaryItemId: 'primary-pub-item',
          duplicateItemIds: ['dup-pub-item'],
          projectId: mockProjectId,
        },
        mockProjectId,
      );

      // Verify userPublication was created for primary item
      expect(mockTx.userPublication.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: mockUserId,
          itemId: 'primary-pub-item',
          isPublic: true,
          openAccessLicense: 'CC-BY-4.0',
          contributorId: 'contrib-123',
        }),
      });

      // Verify duplicate record was deleted
      expect(mockTx.userPublication.delete).toHaveBeenCalledWith({
        where: {
          userId_itemId: {
            userId: mockUserId,
            itemId: 'dup-pub-item',
          },
        },
      });
    });

    it('should re-parent upstream item_metadata snapshots to primary item', async () => {
      const primaryItem = fromPartial<ItemDetail>({
        id: 'primary-meta-item',
        title: 'Primary Meta Item',
        version: 1,
      });
      const duplicateItem = fromPartial<ItemDetail>({
        id: 'dup-meta-item',
        title: 'Duplicate Meta Item',
        version: 1,
      });

      mockBibliographyFacade.findByIds.mockResolvedValueOnce([
        primaryItem,
        duplicateItem,
      ]);

      await service.mergeDuplicates(
        mockUserId,
        {
          primaryItemId: 'primary-meta-item',
          duplicateItemIds: ['dup-meta-item'],
          projectId: mockProjectId,
        },
        mockProjectId,
      );

      // Verify itemMetadata snapshots re-parented to primary item
      expect(mockTx.itemMetadata.updateMany).toHaveBeenCalledWith({
        where: { itemId: { in: ['dup-meta-item'] } },
        data: { itemId: 'primary-meta-item' },
      });
    });
  });
});
