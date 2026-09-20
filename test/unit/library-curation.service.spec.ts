import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { fromPartial } from '@total-typescript/shoehorn';
import { Prisma } from '@prisma/client';
import { DuplicateService } from '@/modules/library/processing/application/services/duplicate.service';
import { PrismaService } from '@/core/database/prisma.service';
import {
  TransactionService,
  TransactionHelpers,
} from '@/modules/library/shared-kernel/outbox/transaction.service';
import { TagsService } from '@/modules/library/catalog/application/services/tags.service';
import { CollectionsService } from '@/modules/library/catalog/application/services/collections.service';
import { AttachmentsService } from '@/modules/library/content/application/services/attachments.service';
import { NotesService } from '@/modules/library/content/application/services/notes.service';
import { StateService } from '@/modules/library/catalog/application/services/state.service';
import {
  ITEM_READ_PORT,
  IItemReadPort,
  ItemDetail,
} from '@/modules/library/catalog/domain/ports/items.ports';
import {
  normalizeTitleForDedupe,
  extractFirstAuthorFamily,
  generateDedupeBucketKey,
} from '@/modules/library/processing/application/utils/curation.utils';

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
    let mockTagsService: jest.Mocked<TagsService>;
    let mockCollectionsService: jest.Mocked<CollectionsService>;
    let mockAttachmentsService: jest.Mocked<AttachmentsService>;
    let mockNotesService: jest.Mocked<NotesService>;
    let mockStateService: jest.Mocked<StateService>;
    let mockItemReadPort: jest.Mocked<IItemReadPort>;
    let mockTx: any;
    let mockHelpers: jest.Mocked<TransactionHelpers>;

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
      });

      mockLibraryTx = {
        executeInTransaction: jest
          .fn()
          .mockImplementation((cb: any) => cb(mockTx, mockHelpers)),
      };

      mockTagsService = fromPartial({
        mergeTagsToItem: jest.fn().mockResolvedValue(undefined),
      });
      mockCollectionsService = fromPartial({
        transferItemMemberships: jest.fn().mockResolvedValue(undefined),
      });
      mockAttachmentsService = fromPartial({
        reassignToItem: jest.fn().mockResolvedValue(undefined),
      });
      mockNotesService = fromPartial({
        reassignToItem: jest.fn().mockResolvedValue(undefined),
      });
      mockStateService = fromPartial({
        transferUserItemStates: jest.fn().mockResolvedValue(undefined),
      });
      mockItemReadPort = fromPartial({
        findDuplicateCandidateItems: jest.fn(),
        findByIds: jest.fn(),
      });
      mockPrisma = fromPartial({});

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          DuplicateService,
          { provide: PrismaService, useValue: mockPrisma },
          { provide: TransactionService, useValue: mockLibraryTx },
          { provide: TagsService, useValue: mockTagsService },
          { provide: CollectionsService, useValue: mockCollectionsService },
          { provide: AttachmentsService, useValue: mockAttachmentsService },
          { provide: NotesService, useValue: mockNotesService },
          { provide: StateService, useValue: mockStateService },
          { provide: ITEM_READ_PORT, useValue: mockItemReadPort },
        ],
      }).compile();

      service = module.get<DuplicateService>(DuplicateService);
    });

    it('should detect duplicate items via exact normalized DOI', async () => {
      mockItemReadPort.findDuplicateCandidateItems.mockResolvedValueOnce([
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
      mockItemReadPort.findDuplicateCandidateItems.mockResolvedValueOnce([
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

      mockItemReadPort.findByIds.mockResolvedValueOnce([
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
      // Verify sub-services were orchestrated
      expect(mockAttachmentsService.reassignToItem).toHaveBeenCalledWith(
        ['dup-2'],
        'primary-1',
        mockTx,
      );
      expect(mockNotesService.reassignToItem).toHaveBeenCalledWith(
        ['dup-2'],
        'primary-1',
        mockTx,
      );
      expect(mockTagsService.mergeTagsToItem).toHaveBeenCalledWith(
        mockTx,
        ['dup-2'],
        'primary-1',
      );
      expect(
        mockCollectionsService.transferItemMemberships,
      ).toHaveBeenCalledWith(['dup-2'], 'primary-1', mockTx);
      expect(mockStateService.transferUserItemStates).toHaveBeenCalledWith(
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
            extra: expect.stringContaining('"mergedIntoId":"primary-1"'),
          }),
        }),
      );

      expect(result.mergedCount).toBe(1);
      expect(result.softDeletedItemIds).toEqual(['dup-2']);
    });

    it('should auto-resolve cluster using "most_complete" strategy and borrow missing fields', async () => {
      // 1. Setup candidate items in detectDuplicates
      mockItemReadPort.findDuplicateCandidateItems.mockResolvedValue([
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

      // 2. Setup candidate items fetched by itemReadPort.findByIds for ranking & merge
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
      mockItemReadPort.findByIds
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
      mockItemReadPort.findDuplicateCandidateItems.mockResolvedValueOnce([]);

      await expect(
        service.autoResolveCluster(mockUserId, 'non-existent-cluster'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if cluster contains fewer than 2 items to merge', async () => {
      mockItemReadPort.findDuplicateCandidateItems.mockResolvedValue([
        fromPartial({ id: 'item-1', doi: '10.1/1', title: 'Paper 1' }),
        fromPartial({ id: 'item-2', doi: '10.1/1', title: 'Paper 2' }),
      ]);

      // simulate only 1 item remaining in DB (one already deleted)
      mockItemReadPort.findByIds.mockResolvedValueOnce([
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
  });
});
