import { Prisma, AnnotationType } from '@prisma/client';
import { DuplicateDetectorService } from '@/modules/library/ingestion/services/duplicate-detector.service';
import { DuplicateMergerService } from '@/modules/library/ingestion/services/duplicate-merger.service';
import { CatalogFacade } from '@/modules/library/catalog/catalog.facade';
import { AttachmentsRepository } from '@/modules/library/extraction/repositories/attachments.repository';
import { StateService } from '@/modules/library/catalog/services/state.service';
import { TagsService } from '@/modules/library/catalog/services/tags.service';
import { CollectionsService } from '@/modules/library/catalog/services/collections.service';
import { NotesService } from '@/modules/library/catalog/services/notes.service';
import { LIBRARY_EVENT_TYPES } from '@/modules/library/core';
import type { PrismaService } from '@/core';
import type {
  ICatalogFacade,
  IExtractionFacade,
  TransactionHelpers,
} from '@/modules/library/core';
import type { TransactionService } from '@/modules/library/sync';
import type { ItemService } from '@/modules/library/catalog/services/items.service';
import type { ItemQueryService } from '@/modules/library/catalog/services/item-query.service';
import type { TypesService } from '@/modules/library/catalog/services/types.service';
import { CurationController } from '@/modules/library/ingestion/controllers/curation.controller';
import type { QualityService } from '@/modules/library/ingestion/services/quality.service';
import { PROJECT_ROLES_KEY } from '@/modules/project/access';

describe('Wave 6 & Wave 7 — Comprehensive Duplicate Detection & Merge Case Studies (Personal, Project & Systematic Review Benchmarks)', () => {
  const USER_OWNER = '11111111-1111-4111-8111-111111111111';
  const USER_COORD = '22222222-2222-4222-8222-222222222222';
  const USER_CONTRIB = '33333333-3333-4333-8333-333333333333';
  const USER_REVIEWER = '44444444-4444-4444-8444-444444444444';
  const PROJECT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const PROJECT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  const createDuplicateService = (
    txService: TransactionService,
    catalogGateway?: ICatalogFacade,
    extractionGateway?: IExtractionFacade,
  ) =>
  {
    const detector = new DuplicateDetectorService(catalogGateway, undefined, txService);
    const merger = new DuplicateMergerService(txService, catalogGateway, extractionGateway);
    return {
      computeRecommendedMasterId: detector.computeRecommendedMasterId.bind(detector),
      dismissDuplicates: detector.dismissDuplicates.bind(detector),
      detectDuplicates: detector.detectDuplicates.bind(detector),
      mergeDuplicates: merger.mergeDuplicates.bind(merger),
      undoMerge: merger.undoMerge.bind(merger),
    };
  };

  const createMockTxService = (mockTx: Record<string, unknown>) => {
    mockTx.itemMetadata = {
      findFirst: jest.fn(async () => null),
      update: jest.fn(async ({ where, data }: any) => { if (data?.deletedAt) deletedAttachmentIds.push(where.id); return { id: where?.id }; }),
      deleteMany: jest.fn(async () => ({ count: 0 })),
      ...(mockTx.itemMetadata as Record<string, unknown> | undefined),
    };
    const outboxEvents: Array<{
      scope: unknown;
      aggregateId: string;
      eventType: string;
      payload: unknown;
    }> = [];
    const changes: Array<unknown> = [];
    const tombstones: Array<unknown> = [];

    const service = {
      executeInTransaction: jest.fn(
        async <T>(
          fn: (
            tx: Prisma.TransactionClient,
            helpers: TransactionHelpers,
          ) => Promise<T>,
        ) => {
          const helpers: TransactionHelpers = {
            appendChangesBatch: jest.fn(async (scopeOrEntries: unknown, entries?: unknown[]) => {
              const list = Array.isArray(scopeOrEntries)
                ? scopeOrEntries
                : (entries || []).map((e: unknown) => ({ scope: scopeOrEntries, change: e }));
              changes.push(...list);
              return list.length;
            }) as any,
            recordTombstonesBatch: jest.fn(async (scopeOrEntries: unknown, entries?: unknown[]) => {
              const list = Array.isArray(scopeOrEntries)
                ? scopeOrEntries
                : (entries || []).map((e: unknown) => ({ scope: scopeOrEntries, tombstone: e }));
              tombstones.push(...list);
              return list.length;
            }) as any,
            removeTombstone: jest.fn().mockResolvedValue(1),
            removeTombstonesBatch: jest.fn().mockResolvedValue(1),
            publishOutboxBatch: jest.fn(async (scopeOrEvents: unknown, events?: Array<Record<string, unknown>>) => {
              const list = Array.isArray(scopeOrEvents)
                ? scopeOrEvents.map((ev: Record<string, unknown>) => ({
                    scope: { userId: ev.userId, projectId: ev.projectId },
                    aggregateId: String(ev.aggregateId),
                    eventType: String(ev.eventType),
                    payload: ev.payload,
                  }))
                : (events || []).map((ev: Record<string, unknown>) => ({
                    scope: scopeOrEvents,
                    aggregateId: String(ev.aggregateId),
                    eventType: String(ev.eventType),
                    payload: ev.payload,
                  }));
              outboxEvents.push(...list);
              return list.map((_: unknown, idx: number) => `outbox-${idx}`);
            }) as any,
            appendChange: jest.fn(async (scope, change) => {
              changes.push({ scope, change });
            }) as any,
            publishOutbox: jest.fn(
              async (scope, aggregateId, eventType, payload) => {
                outboxEvents.push({ scope, aggregateId, eventType, payload });
              },
            ) as any,
            recordTombstone: jest.fn(async (scope, tombstone) => {
              tombstones.push({ scope, tombstone });
            }) as any,
          };
          return fn(mockTx as unknown as Prisma.TransactionClient, helpers);
        },
      ),
    } as unknown as TransactionService;

    return { service, outboxEvents, changes, tombstones };
  };

  // CASE STUDY 1: Preprint -> Published Journal Article Evolution & Child Notes Reassignment
  describe('Case Study 1: Preprint -> Published Journal Article Evolution & Child Notes Reassignment', () => {
    it('merges an arXiv preprint with its published journal article, preserves both arxivId and DOI, merges citation keys, and reassigns child Note rows via CatalogFacade.mergeItems', async () => {
      const notesReassigned: Array<{
        sourceIds: string[];
        targetId: string;
      }> = [];

      const mockTagsService = {
        mergeTagsToItem: jest.fn(async () => undefined),
      } as unknown as TagsService;
      const mockCollectionsService = {
        transferItemMemberships: jest.fn(async () => undefined),
      } as unknown as CollectionsService;
      const mockStateService = {
        transferUserItemStates: jest.fn(async () => undefined),
      } as unknown as StateService;
      const mockNotesService = {
        reassignToItem: jest.fn(
          async (sourceIds: string[], targetId: string) => {
            notesReassigned.push({ sourceIds, targetId });
          },
        ),
      } as unknown as NotesService;

      const catalogFacade = new CatalogFacade(
        {} as unknown as ItemQueryService,
        {} as unknown as ItemService,
        mockCollectionsService,
        mockTagsService,
        {} as unknown as TypesService,
        mockStateService,
        mockNotesService,
      );

      let updatedPrimaryPayload: any = null;
      const mockTx = {
        $executeRaw: jest.fn(async () => 1),
        itemRelation: { findMany: jest.fn(async () => []) },
        userPublication: { findMany: jest.fn(async () => []) },
        itemMetadata: { updateMany: jest.fn(async () => ({ count: 1 })) },
        contributor: { count: jest.fn(async () => 2) },
        item: {
          update: jest.fn(
            async ({
              where,
              data,
            }: {
              where: { id: string };
              data: Record<string, unknown>;
            }) => {
              if (where.id === 'item-published') {
                updatedPrimaryPayload = data;
              }
              return { id: where.id, version: 2, ...data };
            },
          ),
          findUnique: jest.fn(async () => ({
            id: 'item-published',
            version: 2,
            ...updatedPrimaryPayload,
          })),
        },
      };

      const { service: txService } = createMockTxService(mockTx);

      const mockCatalogGateway: Partial<ICatalogFacade> = {
        findByIds: jest.fn(async () => [
          {
            id: 'item-published',
            userId: USER_OWNER,
            projectId: null,
            itemType: 'journalArticle',
            title: 'Attention Is All You Need',
            year: 2017,
            doi: '10.5555/3295222.3295349',
            publicationTitle:
              'Advances in Neural Information Processing Systems',
            citationKey: 'vaswani2017neurips',
            metadata: {
              volume: '30',
              pages: '5998-6008',
              publisher: 'Curran Associates, Inc.',
            },
            version: 1,
            deletedAt: null,
          },
          {
            id: 'item-preprint',
            userId: USER_OWNER,
            projectId: null,
            itemType: 'preprint',
            title: 'Attention Is All You Need',
            year: 2017,
            doi: null,
            publicationTitle: null,
            citationKey: 'vaswani2017arxiv',
            metadata: {
              arxivId: '1706.03762v5',
              abstract:
                'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.',
            },
            version: 1,
            deletedAt: null,
          },
        ]) as unknown as ICatalogFacade['findByIds'],
        mergeItems: jest.fn(async (tx, dupIds, primaryId) => {
          await catalogFacade.mergeItems(tx, dupIds, primaryId);
        }),
        findDuplicateCandidateItems: jest.fn(async () => []),
      };

      const duplicateService = createDuplicateService(
        txService,
        mockCatalogGateway as unknown as ICatalogFacade,
      );

      await duplicateService.mergeDuplicates(USER_OWNER, {
        primaryItemId: 'item-published',
        duplicateItemIds: ['item-preprint'],
        fieldSelections: {
          itemType: 'journalArticle',
        },
      });

      // Verify child notes were reassigned via CatalogFacade.mergeItems
      expect(notesReassigned).toEqual([
        { sourceIds: ['item-preprint'], targetId: 'item-published' },
      ]);

      // Verify backfilled abstract + arxivId + mergedCitationKeys
      expect(updatedPrimaryPayload).toBeDefined();
      expect(updatedPrimaryPayload?.abstract).toContain(
        'dominant sequence transduction models',
      );
      const mergedMeta = updatedPrimaryPayload?.metadata as Record<
        string,
        unknown
      >;
      expect(mergedMeta.arxivId).toBe('1706.03762v5');
      expect(mergedMeta.volume).toBe('30');
      expect(mergedMeta.mergedCitationKeys).toContain('vaswani2017arxiv');
    });
  });

  // CASE STUDY 2: Identical PDF fileHash Deduplication & Annotation Consolidation
  describe('Case Study 2: Identical PDF fileHash Deduplication & Annotation Consolidation', () => {
    it('deduplicates attachments sharing the same fileHash, consolidates unique annotations onto the surviving PDF, and deletes identical duplicate highlights', async () => {
      const deletedAttachmentIds: string[] = [];
      const deletedAnnotationIds: string[] = [];
      const movedAnnotationUpdates: Array<{
        ids: string[];
        targetAttachmentId: string;
      }> = [];

      const mockPrisma = {
        attachment: {
          findMany: jest.fn(async () => [
            {
              id: 'att-primary',
              itemId: 'item-master',
              fileHash: 'sha256-identical-paper-hash',
              attachmentType: 'primary_pdf',
              linkMode: 'imported_file',
              deletedAt: null,
            },
            {
              id: 'att-dup',
              itemId: 'item-dup',
              fileHash: 'SHA256-IDENTICAL-PAPER-HASH', // case-insensitive match
              attachmentType: 'primary_pdf',
              linkMode: 'imported_file',
              deletedAt: null,
            },
          ]),
          delete: jest.fn(async ({ where }: { where: { id: string } }) => {
            deletedAttachmentIds.push(where.id);
            return { id: where.id };
          }),
          update: jest.fn(async ({ where, data }: { where: { id: string }; data?: { deletedAt?: Date | null } }) => {
            if (data?.deletedAt) deletedAttachmentIds.push(where.id);
            return { id: where.id };
          }),
          updateMany: jest.fn(async () => ({ count: 0 })),
        },
        annotation: {
          findMany: jest.fn(
            async ({
              where,
            }: {
              where: { attachmentId: string; deletedAt: null };
            }) => {
              if (where.attachmentId === 'att-primary') {
                return [
                  {
                    id: 'ann-p1-shared',
                    attachmentId: 'att-primary',
                    pageIndex: 0,
                    type: AnnotationType.highlight,
                    quoteText: 'Shared theorem on page 1',
                  },
                  {
                    id: 'ann-p2-unique-a',
                    attachmentId: 'att-primary',
                    pageIndex: 1,
                    type: AnnotationType.highlight,
                    quoteText: 'Unique highlight on page 2 from Copy A',
                  },
                ];
              }
              return [
                {
                  id: 'ann-p1-dup-copy',
                  attachmentId: 'att-dup',
                  pageIndex: 0,
                  type: AnnotationType.highlight,
                  quoteText: '  shared theorem on page 1  ', // identical highlight -> should be deleted
                },
                {
                  id: 'ann-p4-unique-b',
                  attachmentId: 'att-dup',
                  pageIndex: 3,
                  type: AnnotationType.highlight,
                  quoteText: 'Unique highlight on page 4 from Copy B',
                },
              ];
            },
          ),
          deleteMany: jest.fn(
            async ({ where }: { where: { id: { in: string[] } } }) => {
              deletedAnnotationIds.push(...where.id.in);
              return { count: where.id.in.length };
            },
          ),
          updateMany: jest.fn(
            async ({
              where,
              data,
            }: {
              where: { id: { in: string[] } };
              data: { attachmentId: string };
            }) => {
              movedAnnotationUpdates.push({
                ids: where.id.in,
                targetAttachmentId: data.attachmentId,
              });
              return { count: where.id.in.length };
            },
          ),
        },
      };

      const attachmentsRepo = new AttachmentsRepository(
        mockPrisma as unknown as PrismaService,
      );

      await attachmentsRepo.reassignToItem(['item-dup'], 'item-master');

      // Identical highlight on page 1 deleted, unique highlight on page 4 moved to att-primary
      expect(deletedAnnotationIds).toEqual(['ann-p1-dup-copy']);
      expect(movedAnnotationUpdates).toEqual([
        { ids: ['ann-p4-unique-b'], targetAttachmentId: 'att-primary' },
      ]);
      // Redundant duplicate attachment deleted
      expect(deletedAttachmentIds).toEqual(['att-dup']);
    });
  });

  // CASE STUDY 3: Distinct PDFs on Duplicates — Single primary_pdf Demotion
  describe('Case Study 3: Distinct PDFs on Duplicates — Single primary_pdf Enforcement', () => {
    it('retains both distinct PDFs when fileHashes differ, keeping the master primary_pdf and demoting the duplicate primary_pdf to supplementary', async () => {
      const updatedAttachments: Array<{
        id: string;
        data: Record<string, unknown>;
      }> = [];

      const mockPrisma = {
        attachment: {
          findMany: jest.fn(async () => [
            {
              id: 'att-main-paper',
              itemId: 'item-master',
              fileHash: 'sha256-published-v2',
              attachmentType: 'primary_pdf',
              linkMode: 'imported_file',
              deletedAt: null,
            },
            {
              id: 'att-preprint-v1',
              itemId: 'item-dup',
              fileHash: 'sha256-arxiv-v1',
              attachmentType: 'primary_pdf',
              linkMode: 'imported_file',
              deletedAt: null,
            },
          ]),
          update: jest.fn(
            async ({
              where,
              data,
            }: {
              where: { id: string };
              data: Record<string, unknown>;
            }) => {
              updatedAttachments.push({ id: where.id, data });
              return { id: where.id, ...data };
            },
          ),
        },
      };

      const attachmentsRepo = new AttachmentsRepository(
        mockPrisma as unknown as PrismaService,
      );

      await attachmentsRepo.reassignToItem(['item-dup'], 'item-master');

      expect(updatedAttachments).toEqual([
        {
          id: 'att-preprint-v1',
          data: {
            itemId: 'item-master',
            attachmentType: 'supplementary',
          },
        },
      ]);
    });
  });

  // CASE STUDY 4: Non-Destructive Zotero Extra Field & Identifier Merging
  describe('Case Study 4: Non-Destructive Zotero Extra Field & Identifier Merging (No Circular Reference)', () => {
    it('merges unique string lines in metadata.extra without creating a circular reference and backfills PMID/PMCID', async () => {
      let savedMetadata: any = null;

      const mockTx = {
        $executeRaw: jest.fn(async () => 1),
        itemRelation: { findMany: jest.fn(async () => []) },
        userPublication: { findMany: jest.fn(async () => []) },
        itemMetadata: { updateMany: jest.fn(async () => ({ count: 1 })) },
        contributor: { count: jest.fn(async () => 1) },
        item: {
          update: jest.fn(
            async ({
              where,
              data,
            }: {
              where: { id: string };
              data: Record<string, unknown>;
            }) => {
              if (where.id === 'item-a') {
                savedMetadata = data.metadata as Record<string, unknown>;
              }
              return { id: where.id, version: 2, ...data };
            },
          ),
          findUnique: jest.fn(async () => ({
            id: 'item-a',
            version: 2,
            metadata: savedMetadata,
          })),
        },
      };

      const { service: txService } = createMockTxService(mockTx);

      const mockCatalogGateway: Partial<ICatalogFacade> = {
        findByIds: jest.fn(async () => [
          {
            id: 'item-a',
            userId: USER_OWNER,
            projectId: null,
            itemType: 'journalArticle',
            title: 'CRISPR-Cas9 Genome Editing',
            year: 2014,
            doi: '10.1126/science.1258096',
            citationKey: 'doudna2014crispr',
            metadata: {
              pmid: '25430774',
              extra: 'PMID: 25430774\nOriginal Date: 2014-11-28',
            },
            version: 1,
            deletedAt: null,
          },
          {
            id: 'item-b',
            userId: USER_OWNER,
            projectId: null,
            itemType: 'journalArticle',
            title: 'CRISPR-Cas9 Genome Editing',
            year: 2014,
            doi: '10.1126/science.1258096',
            citationKey: 'doudna2014science',
            metadata: {
              pmcid: 'PMC4343198',
              extra:
                'PMCID: PMC4343198\nPMID: 25430774\ntex.ids: doudna2014old',
            },
            version: 1,
            deletedAt: null,
          },
        ]) as unknown as ICatalogFacade['findByIds'],
        mergeItems: jest.fn(async () => undefined),
        findDuplicateCandidateItems: jest.fn(async () => []),
      };

      const duplicateService = createDuplicateService(
        txService,
        mockCatalogGateway as unknown as ICatalogFacade,
      );

      await duplicateService.mergeDuplicates(USER_OWNER, {
        primaryItemId: 'item-a',
        duplicateItemIds: ['item-b'],
      });

      expect(savedMetadata).toBeDefined();
      // Must serialize cleanly to JSON (zero circular references!)
      expect(() => JSON.stringify(savedMetadata)).not.toThrow();
      expect(typeof savedMetadata?.extra).toBe('string');
      expect(savedMetadata?.extra).toBe(
        [
          'PMID: 25430774',
          'Original Date: 2014-11-28',
          'PMCID: PMC4343198',
          'tex.ids: doudna2014old',
        ].join('\n'),
      );
      expect(savedMetadata?.pmid).toBe('25430774');
      expect(savedMetadata?.pmcid).toBe('PMC4343198');
      expect(savedMetadata?.mergedCitationKeys).toEqual(['doudna2014science']);
    });
  });

  // CASE STUDY 5: Project Library Multi-Member Independent Reading States
  describe('Case Study 5: Project Library Multi-Member Independent Reading States (4 Roles)', () => {
    it('consolidates reading states per member independently across duplicates and selects scrollPosition from the most recently read duplicate', async () => {
      const upsertedStates = new Map<string, Record<string, unknown>>();

      const mockTx = {
        state: {
          findMany: jest.fn(async () => [
            // Owner: read Dup 1 earlier (page 5), then read Dup 2 later (page 18)
            {
              userId: USER_OWNER,
              itemId: 'item-dup-1',
              isStarred: false,
              rating: 3,
              readStatus: 'reading',
              currentPage: 5,
              scrollPosition: { page: 5, offset: 0.1 },
              lastOpenedAt: new Date('2026-03-01T10:00:00Z'),
              lastReadAt: new Date('2026-03-01T10:00:00Z'),
            },
            {
              userId: USER_OWNER,
              itemId: 'item-dup-2',
              isStarred: true,
              rating: 5,
              readStatus: 'reading',
              currentPage: 18,
              scrollPosition: { page: 18, offset: 0.75 },
              lastOpenedAt: new Date('2026-03-10T15:30:00Z'),
              lastReadAt: new Date('2026-03-10T15:30:00Z'),
            },
            // Coordinator: completed Dup 1
            {
              userId: USER_COORD,
              itemId: 'item-dup-1',
              isStarred: false,
              rating: 4,
              readStatus: 'completed',
              currentPage: 24,
              scrollPosition: { page: 24, offset: 1.0 },
              lastOpenedAt: new Date('2026-03-05T12:00:00Z'),
              lastReadAt: new Date('2026-03-05T12:00:00Z'),
            },
            // Contributor: starred Dup 2, rated Dup 1
            {
              userId: USER_CONTRIB,
              itemId: 'item-dup-1',
              isStarred: false,
              rating: 5,
              readStatus: 'unread',
              currentPage: 1,
              scrollPosition: null,
              lastOpenedAt: null,
              lastReadAt: null,
            },
            {
              userId: USER_CONTRIB,
              itemId: 'item-dup-2',
              isStarred: true,
              rating: 0,
              readStatus: 'reading',
              currentPage: 9,
              scrollPosition: { page: 9, offset: 0.4 },
              lastOpenedAt: new Date('2026-03-08T09:00:00Z'),
              lastReadAt: new Date('2026-03-08T09:00:00Z'),
            },
            // Reviewer: unread on Dup 2
            {
              userId: USER_REVIEWER,
              itemId: 'item-dup-2',
              isStarred: false,
              rating: 0,
              readStatus: 'unread',
              currentPage: 1,
              scrollPosition: null,
              lastOpenedAt: null,
              lastReadAt: null,
            },
          ]),
          upsert: jest.fn(
            async ({
              where,
              create,
            }: {
              where: { userId_itemId: { userId: string; itemId: string } };
              create: Record<string, unknown>;
            }) => {
              upsertedStates.set(where.userId_itemId.userId, create);
              return create;
            },
          ),
          deleteMany: jest.fn(async () => ({ count: 6 })),
        },
      };

      const stateService = new StateService({} as never, {} as never);
      await stateService.transferUserItemStates(
        mockTx as unknown as Prisma.TransactionClient,
        ['item-dup-2'],
        'item-dup-1',
      );

      expect(upsertedStates.size).toBe(4);

      // Owner gets scrollPosition from item-dup-2 (most recent lastReadAt: March 10, page 18)
      expect(upsertedStates.get(USER_OWNER)).toEqual(
        expect.objectContaining({
          userId: USER_OWNER,
          itemId: 'item-dup-1',
          isStarred: true,
          rating: 5,
          readStatus: 'reading',
          currentPage: 18,
          scrollPosition: { page: 18, offset: 0.75 },
        }),
      );

      // Coordinator keeps completed status
      expect(upsertedStates.get(USER_COORD)).toEqual(
        expect.objectContaining({
          readStatus: 'completed',
          currentPage: 24,
        }),
      );

      // Contributor merges rating 5 from Dup 1 + isStarred & reading progress from Dup 2
      expect(upsertedStates.get(USER_CONTRIB)).toEqual(
        expect.objectContaining({
          isStarred: true,
          rating: 5,
          readStatus: 'reading',
          currentPage: 9,
          scrollPosition: { page: 9, offset: 0.4 },
        }),
      );

      // Reviewer remains unread without leaking other members' state
      expect(upsertedStates.get(USER_REVIEWER)).toEqual(
        expect.objectContaining({
          isStarred: false,
          rating: 0,
          readStatus: 'unread',
        }),
      );
    });
  });

  // CASE STUDY 6: Cross-Scope Merge Security Guard & Scope Normalization
  describe('Case Study 6: Cross-Scope Merge Security Guard (Personal vs Project & Project A vs Project B)', () => {
    it('rejects merging items across Personal and Project scopes or between two different Projects, and normalizes "personal"/"user"/"me" to undefined', async () => {
      const { service: txService } = createMockTxService({});

      const mockCatalogGateway: Partial<ICatalogFacade> = {
        findByIds: jest.fn(async (_userId: string, ids: string[]) =>
          ids.map((id: string) => ({
            id,
            userId: USER_OWNER,
            projectId: id === 'item-personal' ? null : PROJECT_A,
            itemType: 'journalArticle',
            title: 'Cross Scope Paper',
            version: 1,
            deletedAt: null,
          })),
        ) as any,
        mergeItems: jest.fn(async () => undefined),
        findDuplicateCandidateItems: jest.fn(async () => []),
      };

      const duplicateService = createDuplicateService(
        txService,
        mockCatalogGateway as unknown as ICatalogFacade,
      );

      // 1. Personal item merged with Project A item -> rejected
      await expect(
        duplicateService.mergeDuplicates(
          USER_OWNER,
          {
            primaryItemId: 'item-personal',
            duplicateItemIds: ['item-project-a'],
          },
          'personal',
        ),
      ).rejects.toThrow(/Cannot merge items across different library scopes/i);

      // 2. Project A item merged under Project B context -> rejected
      await expect(
        duplicateService.mergeDuplicates(
          USER_OWNER,
          {
            primaryItemId: 'item-project-a-1',
            duplicateItemIds: ['item-project-a-2'],
          },
          PROJECT_B,
        ),
      ).rejects.toThrow(/Cannot merge items across different library scopes/i);

      // 3. Verify detectDuplicates normalizes 'user' / 'personal' to undefined
      await duplicateService.detectDuplicates(USER_OWNER, 'user');
      expect(
        mockCatalogGateway.findDuplicateCandidateItems,
      ).toHaveBeenCalledWith(USER_OWNER, undefined, undefined);
    });
  });

  // CASE STUDY 7: "Not Duplicates" Dismissal for Multi-Part Companion Papers
  describe('Case Study 7: "Not Duplicates" Dismissal for Multi-Part Companion Papers', () => {
    it('allows dismissing false-positive companion papers (Part I & Part II) so detectDuplicates no longer clusters them together', async () => {
      const itemsStore: Array<{
        id: string;
        userId: string;
        projectId: string | null;
        title: string;
        itemType: string;
        year: number;
        authors: string[];
        metadata: Record<string, unknown>;
      }> = [
        {
          id: 'paper-part-1',
          userId: USER_OWNER,
          projectId: null,
          title:
            'Mathematical Foundations of Differential Privacy in Federated Learning Systems: Theory and Practice (Expanded Edition)',
          itemType: 'conferencePaper',
          year: 2025,
          authors: ['Elena Rostova'],
          metadata: {},
        },
        {
          id: 'paper-part-2',
          userId: USER_OWNER,
          projectId: null,
          title:
            'Mathematical Foundations of Differential Privacy in Federated Learning Systems: Theory and Practice (Extended Edition)',
          itemType: 'journalArticle',
          year: 2025,
          authors: ['Elena Rostova'],
          metadata: {},
        },
      ];

      const mockTx = {
        item: {
          update: jest.fn(
            async ({
              where,
              data,
            }: {
              where: { id: string };
              data: { metadata: Record<string, unknown> };
            }) => {
              const target = itemsStore.find((it) => it.id === where.id);
              if (target) {
                target.metadata = data.metadata;
              }
              return target;
            },
          ),
        },
      };

      const { service: txService } = createMockTxService(mockTx);

      const mockCatalogGateway: Partial<ICatalogFacade> = {
        findDuplicateCandidateItems: jest.fn(
          async () => itemsStore,
        ) as unknown as ICatalogFacade['findDuplicateCandidateItems'],
        findByIds: jest.fn(async (_userId, ids) =>
          itemsStore.filter((it) => ids.includes(it.id)),
        ) as unknown as ICatalogFacade['findByIds'],
        mergeItems: jest.fn(async () => undefined),
      };

      const duplicateService = createDuplicateService(
        txService,
        mockCatalogGateway as unknown as ICatalogFacade,
      );

      // Before dismissal: Part I and Part II match via fuzzy title + year + author
      const beforeClusters =
        await duplicateService.detectDuplicates(USER_OWNER);
      expect(beforeClusters).toHaveLength(1);
      expect(beforeClusters[0].items.map((i) => i.id)).toEqual([
        'paper-part-1',
        'paper-part-2',
      ]);

      // User marks Part I and Part II as "Not Duplicates"
      const dismissResult = await duplicateService.dismissDuplicates(
        USER_OWNER,
        ['paper-part-1', 'paper-part-2'],
        'personal',
      );
      expect(dismissResult).toEqual({
        dismissed: true,
        itemIds: ['paper-part-1', 'paper-part-2'],
      });

      // After dismissal: detectDuplicates skips the dismissed pair
      const afterClusters = await duplicateService.detectDuplicates(USER_OWNER);
      expect(afterClusters).toHaveLength(0);
    });
  });

  // CASE STUDY 8: Bidirectional ItemRelation Consolidation & Self-Loop Prevention
  describe('Case Study 8: Bidirectional ItemRelation Consolidation & Self-Loop Prevention', () => {
    it('rewires relations from duplicates to primary, deletes Master<->Duplicate self-relations, and deduplicates parallel edges to external items', async () => {
      const deletedRelationIds: string[] = [];
      const updatedRelations: Array<{
        id: string;
        data: { sourceItemId: string; targetItemId: string };
      }> = [];

      const mockTx = {
        $executeRaw: jest.fn(async () => 1),
        itemRelation: {
          findMany: jest.fn(async () => [
            // 1. Relation between primary and dup-1 -> becomes self-loop, must be deleted!
            {
              id: 'rel-self-loop',
              sourceItemId: 'item-master',
              targetItemId: 'item-dup-1',
              relationType: 'related',
            },
            // 2. Existing relation from master to external paper X
            {
              id: 'rel-master-cites-x',
              sourceItemId: 'item-master',
              targetItemId: 'item-external-x',
              relationType: 'cites',
            },
            // 3. Parallel relation from dup-1 to external paper X -> duplicate edge, must be deleted!
            {
              id: 'rel-dup1-cites-x',
              sourceItemId: 'item-dup-1',
              targetItemId: 'item-external-x',
              relationType: 'cites',
            },
            // 4. Unique relation from external paper Y to dup-2 -> must be rewired to item-master!
            {
              id: 'rel-y-cites-dup2',
              sourceItemId: 'item-external-y',
              targetItemId: 'item-dup-2',
              relationType: 'cites',
            },
          ]),
          delete: jest.fn(async ({ where }: { where: { id: string } }) => {
            deletedRelationIds.push(where.id);
            return { id: where.id };
          }),
          update: jest.fn(
            async ({
              where,
              data,
            }: {
              where: { id: string };
              data: { sourceItemId: string; targetItemId: string };
            }) => {
              updatedRelations.push({ id: where.id, data });
              return { id: where.id, ...data };
            },
          ),
        },
        userPublication: { findMany: jest.fn(async () => []) },
        itemMetadata: { updateMany: jest.fn(async () => ({ count: 0 })) },
        contributor: { count: jest.fn(async () => 1) },
        item: {
          update: jest.fn(
            async ({
              where,
              data,
            }: {
              where: { id: string };
              data: Record<string, unknown>;
            }) => ({
              id: where.id,
              version: 2,
              ...data,
            }),
          ),
          findUnique: jest.fn(async () => ({ id: 'item-master', version: 2 })),
        },
      };

      const { service: txService } = createMockTxService(mockTx);

      const mockCatalogGateway: Partial<ICatalogFacade> = {
        findByIds: jest.fn(async () => [
          {
            id: 'item-master',
            userId: USER_OWNER,
            projectId: null,
            itemType: 'journalArticle',
            title: 'Graph Neural Networks',
            version: 1,
            deletedAt: null,
          },
          {
            id: 'item-dup-1',
            userId: USER_OWNER,
            projectId: null,
            itemType: 'journalArticle',
            title: 'Graph Neural Networks',
            version: 1,
            deletedAt: null,
          },
          {
            id: 'item-dup-2',
            userId: USER_OWNER,
            projectId: null,
            itemType: 'journalArticle',
            title: 'Graph Neural Networks',
            version: 1,
            deletedAt: null,
          },
        ]) as unknown as ICatalogFacade['findByIds'],
        mergeItems: jest.fn(async () => undefined),
        findDuplicateCandidateItems: jest.fn(async () => []),
      };

      const duplicateService = createDuplicateService(
        txService,
        mockCatalogGateway as unknown as ICatalogFacade,
      );

      await duplicateService.mergeDuplicates(USER_OWNER, {
        primaryItemId: 'item-master',
        duplicateItemIds: ['item-dup-1', 'item-dup-2'],
      });

      expect(deletedRelationIds).toEqual(['rel-self-loop', 'rel-dup1-cites-x']);
      expect(updatedRelations).toEqual([
        {
          id: 'rel-y-cites-dup2',
          data: {
            sourceItemId: 'item-external-y',
            targetItemId: 'item-master',
          },
        },
      ]);
    });
  });

  // CASE STUDY 9: Retraction Warning Survival Across Merge
  describe('Case Study 9: Retraction Warning Survival Across Merge', () => {
    it('preserves isRetracted=true and retraction provenance when a retracted duplicate is merged into an unflagged primary item', async () => {
      let updatedPrimaryData: any = null;

      const mockTx = {
        $executeRaw: jest.fn(async () => 1),
        itemRelation: { findMany: jest.fn(async () => []) },
        userPublication: { findMany: jest.fn(async () => []) },
        itemMetadata: { updateMany: jest.fn(async () => ({ count: 1 })) },
        contributor: { count: jest.fn(async () => 1) },
        item: {
          update: jest.fn(
            async ({
              where,
              data,
            }: {
              where: { id: string };
              data: Record<string, unknown>;
            }) => {
              if (where.id === 'item-unflagged-master') {
                updatedPrimaryData = data;
              }
              return { id: where.id, version: 2, ...data };
            },
          ),
          findUnique: jest.fn(async () => ({
            id: 'item-unflagged-master',
            version: 2,
            ...updatedPrimaryData,
          })),
        },
      };

      const { service: txService } = createMockTxService(mockTx);

      const mockCatalogGateway: Partial<ICatalogFacade> = {
        findByIds: jest.fn(async () => [
          {
            id: 'item-unflagged-master',
            userId: USER_OWNER,
            projectId: null,
            itemType: 'journalArticle',
            title:
              'Room-Temperature Superconductivity in Nitrogen-Doped Lutetium Hydride',
            isRetracted: false,
            metadata: {},
            version: 1,
            deletedAt: null,
          },
          {
            id: 'item-retracted-dup',
            userId: USER_OWNER,
            projectId: null,
            itemType: 'journalArticle',
            title:
              'Room-Temperature Superconductivity in Nitrogen-Doped Lutetium Hydride',
            isRetracted: true,
            metadata: {
              isRetracted: true,
              retractionNature: 'Retraction',
              retractionDate: '2023-11-07',
              retractionReasons: ['Concerns about data reliability'],
              retractionNoticeDoi: '10.1038/s41586-023-06774-2',
            },
            version: 1,
            deletedAt: null,
          },
        ]) as unknown as ICatalogFacade['findByIds'],
        mergeItems: jest.fn(async () => undefined),
        findDuplicateCandidateItems: jest.fn(async () => []),
      };

      const duplicateService = createDuplicateService(
        txService,
        mockCatalogGateway as unknown as ICatalogFacade,
      );

      await duplicateService.mergeDuplicates(USER_OWNER, {
        primaryItemId: 'item-unflagged-master',
        duplicateItemIds: ['item-retracted-dup'],
      });

      // isRetracted is not an Item column; it is persisted in metadata (asserted below).
      const mergedMeta = updatedPrimaryData?.metadata as Record<
        string,
        unknown
      >;
      expect(mergedMeta.isRetracted).toBe(true);
      expect(mergedMeta.retractionNature).toBe('Retraction');
      expect(mergedMeta.retractionDate).toBe('2023-11-07');
      expect(mergedMeta.retractionReasons).toEqual([
        'Concerns about data reliability',
      ]);
      expect(mergedMeta.retractionNoticeDoi).toBe('10.1038/s41586-023-06774-2');
    });
  });

  // CASE STUDY 10: N-Way Cluster Merge with Collections, Tags & Outbox Sync Events
  describe('Case Study 10: 4-Way Cluster Merge (arXiv + PubMed + CrossRef + Manual) with Outbox Sync Events', () => {
    it('consolidates a 4-item duplicate cluster in a Project Library, soft-deletes all 3 duplicates with merge tombstones, and emits library.items.merged', async () => {
      const softDeletedIds: string[] = [];
      let masterUpdateData: any = null;

      const mockTx = {
        $executeRaw: jest.fn(async () => 1),
        itemRelation: { findMany: jest.fn(async () => []) },
        userPublication: { findMany: jest.fn(async () => []) },
        itemMetadata: { updateMany: jest.fn(async () => ({ count: 3 })) },
        contributor: {
          count: jest.fn(async () => 0),
          createMany: jest.fn(async () => ({ count: 2 })),
        },
        item: {
          update: jest.fn(
            async ({
              where,
              data,
            }: {
              where: { id: string };
              data: Record<string, unknown>;
            }) => {
              if (where.id === 'item-crossref') {
                masterUpdateData = data;
              } else {
                softDeletedIds.push(where.id);
              }
              return { id: where.id, version: 2, ...data };
            },
          ),
          findUnique: jest.fn(async () => ({
            id: 'item-crossref',
            version: 2,
            ...masterUpdateData,
          })),
        },
      };

      const {
        service: txService,
        outboxEvents,
        tombstones,
      } = createMockTxService(mockTx);

      const mockCatalogGateway: Partial<ICatalogFacade> = {
        findByIds: jest.fn(async () => [
          {
            id: 'item-crossref',
            userId: USER_OWNER,
            projectId: PROJECT_A,
            itemType: 'journalArticle',
            title: 'AlphaFold: Highly Accurate Protein Structure Prediction',
            year: 2021,
            doi: '10.1038/s41586-021-03819-2',
            publicationTitle: 'Nature',
            citationKey: 'jumper2021nature',
            metadata: { volume: '596', pages: '583-589' },
            contributors: [],
            version: 1,
            deletedAt: null,
          },
          {
            id: 'item-pubmed',
            userId: USER_COORD,
            projectId: PROJECT_A,
            itemType: 'journalArticle',
            title:
              'Highly accurate protein structure prediction with AlphaFold',
            year: 2021,
            doi: '10.1038/s41586-021-03819-2',
            citationKey: 'jumper2021pmid',
            metadata: { pmid: '34265844', pmcid: 'PMC8371605' },
            contributors: [
              {
                creatorType: 'author',
                firstName: 'John',
                lastName: 'Jumper',
                fullName: 'John Jumper',
                orderIndex: 0,
              },
              {
                creatorType: 'author',
                firstName: 'Demis',
                lastName: 'Hassabis',
                fullName: 'Demis Hassabis',
                orderIndex: 1,
              },
            ],
            version: 1,
            deletedAt: null,
          },
          {
            id: 'item-arxiv',
            userId: USER_CONTRIB,
            projectId: PROJECT_A,
            itemType: 'journalArticle',
            title:
              'Highly accurate protein structure prediction with AlphaFold',
            year: 2021,
            citationKey: 'jumper2021biorxiv',
            abstract:
              'Proteins are essential to life, and understanding their structure can facilitate a mechanistic understanding of their function.',
            metadata: { arxivId: '2107.00001' },
            version: 1,
            deletedAt: null,
          },
          {
            id: 'item-manual',
            userId: USER_REVIEWER,
            projectId: PROJECT_A,
            itemType: 'journalArticle',
            title: 'AlphaFold Nature Paper',
            year: 2021,
            url: 'https://www.nature.com/articles/s41586-021-03819-2',
            citationKey: 'alphafold2021manual',
            metadata: { extra: 'Read in Journal Club Week 4' },
            version: 1,
            deletedAt: null,
          },
        ]) as unknown as ICatalogFacade['findByIds'],
        mergeItems: jest.fn(async () => undefined),
        findDuplicateCandidateItems: jest.fn(async () => []),
      };

      const mockExtractionGateway: IExtractionFacade = {
        reassignContentToItem: jest.fn(async () => undefined),
      } as unknown as IExtractionFacade;

      const duplicateService = createDuplicateService(
        txService,
        mockCatalogGateway as unknown as ICatalogFacade,
        mockExtractionGateway,
      );

      const result = await duplicateService.mergeDuplicates(
        USER_OWNER,
        {
          primaryItemId: 'item-crossref',
          duplicateItemIds: ['item-pubmed', 'item-arxiv', 'item-manual'],
        },
        PROJECT_A,
      );

      expect(result.mergedCount).toBe(3);
      expect(softDeletedIds).toEqual([
        'item-pubmed',
        'item-arxiv',
        'item-manual',
      ]);
      expect(tombstones).toHaveLength(3);

      // Borrowed contributors from item-pubmed because item-crossref had 0 contributors
      expect(mockTx.contributor.createMany).toHaveBeenCalledTimes(1);

      // Backfilled abstract from item-arxiv, url from item-manual, pmid/pmcid from item-pubmed, arxivId from item-arxiv
      expect(masterUpdateData?.abstract).toContain(
        'Proteins are essential to life',
      );
      expect(masterUpdateData?.url).toBe(
        'https://www.nature.com/articles/s41586-021-03819-2',
      );
      const mergedMeta = masterUpdateData?.metadata as Record<string, unknown>;
      expect(mergedMeta.pmid).toBe('34265844');
      expect(mergedMeta.pmcid).toBe('PMC8371605');
      expect(mergedMeta.arxivId).toBe('2107.00001');
      expect(mergedMeta.extra).toBe('Read in Journal Club Week 4');
      expect(mergedMeta.mergedCitationKeys).toEqual([
        'jumper2021pmid',
        'jumper2021biorxiv',
        'alphafold2021manual',
      ]);

      // Emitted 1 primary ITEM_MERGED event + 3 duplicate merged_into events
      const mergedPrimaryEvents = outboxEvents.filter(
        (e) => e.eventType === LIBRARY_EVENT_TYPES.ITEM_MERGED,
      );
      expect(mergedPrimaryEvents).toHaveLength(1);
      expect(mergedPrimaryEvents[0].payload).toEqual(
        expect.objectContaining({
          primaryItemId: 'item-crossref',
          duplicateItemIds: ['item-pubmed', 'item-arxiv', 'item-manual'],
          mergedCount: 3,
          projectId: PROJECT_A,
        }),
      );
    });
  });

  // CASE STUDY 11: Zotero 8.0.2 Book Chapters Sharing Parent ISBN & Multi-Volume Books
  describe('Case Study 11: Zotero 8.0.2 Book Chapters Sharing Parent ISBN & Multi-Volume Books', () => {
    it('does NOT falsely flag distinct book chapters (bookSection) or multi-volume books sharing a parent ISBN, while detecting true duplicate chapters', async () => {
      const candidateItems = [
        // 3 distinct chapters from Goodfellow et al. Deep Learning (sharing ISBN 978-0-262-03561-3)
        {
          id: 'ch-1',
          title: 'Applied Math and Machine Learning Basics',
          itemType: 'bookSection',
          isbn: '978-0-262-03561-3',
          year: 2016,
          authors: ['Ian Goodfellow', 'Yoshua Bengio', 'Aaron Courville'],
          metadata: {
            bookTitle: 'Deep Learning',
            pages: '1-161',
          },
        },
        {
          id: 'ch-2',
          title: 'Deep Networks: Modern Practices',
          itemType: 'bookSection',
          isbn: '978-0-262-03561-3',
          year: 2016,
          authors: ['Ian Goodfellow', 'Yoshua Bengio', 'Aaron Courville'],
          metadata: {
            bookTitle: 'Deep Learning',
            pages: '163-482',
          },
        },
        {
          id: 'ch-3-copy-a',
          title:
            'Deep Learning Research: Autoencoders and Representation Learning',
          itemType: 'bookSection',
          isbn: '978-0-262-03561-3',
          year: 2016,
          authors: ['Ian Goodfellow', 'Yoshua Bengio', 'Aaron Courville'],
          metadata: {
            bookTitle: 'Deep Learning',
            pages: '483-525',
          },
        },
        // True duplicate import of Chapter 3 (with unhyphenated ISBN-13)
        {
          id: 'ch-3-copy-b',
          title:
            'Deep Learning Research: Autoencoders and Representation Learning',
          itemType: 'bookSection',
          isbn: '9780262035613',
          year: 2016,
          authors: ['Goodfellow, Ian', 'Bengio, Yoshua', 'Courville, Aaron'],
          metadata: {
            bookTitle: 'Deep Learning',
            pages: '483-525',
          },
        },
        // Multi-volume book set sharing a set ISBN
        {
          id: 'knuth-vol-1',
          title:
            'The Art of Computer Programming, Volume 1: Fundamental Algorithms',
          itemType: 'book',
          isbn: '978-0-321-75104-1',
          year: 2011,
          authors: ['Donald E. Knuth'],
          metadata: { volume: '1' },
        },
        {
          id: 'knuth-vol-2',
          title:
            'The Art of Computer Programming, Volume 2: Seminumerical Algorithms',
          itemType: 'book',
          isbn: '978-0-321-75104-1',
          year: 2011,
          authors: ['Donald E. Knuth'],
          metadata: { volume: '2' },
        },
      ];

      const { service: txService } = createMockTxService({});
      const mockCatalogGateway: Partial<ICatalogFacade> = {
        findDuplicateCandidateItems: jest.fn(
          async () => candidateItems,
        ) as unknown as ICatalogFacade['findDuplicateCandidateItems'],
        findByIds: jest.fn(async () => []),
        mergeItems: jest.fn(async () => undefined),
      };

      const duplicateService = createDuplicateService(
        txService,
        mockCatalogGateway as unknown as ICatalogFacade,
      );

      const clusters = await duplicateService.detectDuplicates(USER_OWNER);

      // Only the 2 copies of Chapter 3 should be clustered as duplicates
      expect(clusters).toHaveLength(1);
      expect(clusters[0].matchReason).toBe('EXACT_ISBN');
      expect(clusters[0].items.map((i) => i.id)).toEqual([
        'ch-3-copy-a',
        'ch-3-copy-b',
      ]);
    });
  });

  // CASE STUDY 12: Bramer / Deduklick Benchmark: Author Diacritics & LaTeX/HTML Title Normalization
  describe('Case Study 12: Bramer / Deduklick Benchmark — Author Diacritics & LaTeX/HTML Title Normalization', () => {
    it('clusters records across PubMed, Scopus, and BibTeX despite German umlauts (Müller vs Mueller vs Muller), LaTeX math ($\\beta$), HTML tags (<i>β</i>), and trailing [Article] tags', async () => {
      const candidateItems = [
        {
          id: 'pubmed-record',
          title: '<i>β</i>-cell function in type 2 diabetes [Article]',
          itemType: 'journalArticle',
          year: 2024,
          authors: ['Müller, Hans-Jürgen', 'Schröder, K.'],
          metadata: { source: 'PubMed' },
        },
        {
          id: 'scopus-record',
          title: 'Beta-cell function in type 2 diabetes',
          itemType: 'journalArticle',
          year: 2024,
          authors: ['Mueller, H. J.', 'Schroeder, K.'],
          metadata: { source: 'Scopus' },
        },
        {
          id: 'bibtex-record',
          title: '$\\beta$- Cell Function in Type 2 Diabetes (Preprint)',
          itemType: 'preprint',
          year: 2023,
          authors: ['M{\\"u}ller, Hans-J{\\"u}rgen', 'Schroder, K.'],
          metadata: { source: 'BibTeX' },
        },
      ];

      const { service: txService } = createMockTxService({});
      const mockCatalogGateway: Partial<ICatalogFacade> = {
        findDuplicateCandidateItems: jest.fn(
          async () => candidateItems,
        ) as unknown as ICatalogFacade['findDuplicateCandidateItems'],
        findByIds: jest.fn(async () => []),
        mergeItems: jest.fn(async () => undefined),
      };

      const duplicateService = createDuplicateService(
        txService,
        mockCatalogGateway as unknown as ICatalogFacade,
      );

      const clusters = await duplicateService.detectDuplicates(USER_OWNER);
      expect(clusters).toHaveLength(1);
      expect(clusters[0].matchReason).toBe('FUZZY_TITLE_YEAR_AUTHOR');
      expect(clusters[0].items.map((i) => i.id)).toEqual([
        'pubmed-record',
        'scopus-record',
        'bibtex-record',
      ]);
    });
  });

  // CASE STUDY 13: Bramer / Deduklick Benchmark: Erratum, Corrigendum, Comment & Reply Protection
  describe('Case Study 13: Bramer / Deduklick Benchmark — Erratum, Corrigendum, Comment & Reply Protection', () => {
    it('never clusters an Original Paper, its Erratum, a Comment on the paper, and the Reply to Comment on the paper even when authors, year, or parent DOI overlap', async () => {
      const candidateItems = [
        {
          id: 'orig-paper',
          title: 'CRISPR-Cas9 Gene Editing in Human Hematopoietic Stem Cells',
          itemType: 'journalArticle',
          doi: '10.1038/s41591-024-00100-1',
          year: 2024,
          authors: ['Zhang, Feng', 'Doudna, Jennifer A.'],
          metadata: {},
        },
        {
          id: 'erratum-paper',
          title:
            'Author Correction: Erratum: CRISPR-Cas9 Gene Editing in Human Hematopoietic Stem Cells',
          itemType: 'journalArticle',
          // Erroneously exported with parent DOI in some bibliographic feeds
          doi: '10.1038/s41591-024-00100-1',
          year: 2024,
          authors: ['Zhang, Feng', 'Doudna, Jennifer A.'],
          metadata: {},
        },
        {
          id: 'comment-paper',
          title:
            'Comment on: CRISPR-Cas9 Gene Editing in Human Hematopoietic Stem Cells',
          itemType: 'journalArticle',
          year: 2024,
          authors: ['Zhang, Feng', 'Doudna, Jennifer A.'],
          metadata: {},
        },
        {
          id: 'reply-paper',
          title:
            'Reply to Comment on: CRISPR-Cas9 Gene Editing in Human Hematopoietic Stem Cells',
          itemType: 'journalArticle',
          year: 2024,
          authors: ['Zhang, Feng', 'Doudna, Jennifer A.'],
          metadata: {},
        },
      ];

      const { service: txService } = createMockTxService({});
      const mockCatalogGateway: Partial<ICatalogFacade> = {
        findDuplicateCandidateItems: jest.fn(
          async () => candidateItems,
        ) as unknown as ICatalogFacade['findDuplicateCandidateItems'],
        findByIds: jest.fn(async () => []),
        mergeItems: jest.fn(async () => undefined),
      };

      const duplicateService = createDuplicateService(
        txService,
        mockCatalogGateway as unknown as ICatalogFacade,
      );

      const clusters = await duplicateService.detectDuplicates(USER_OWNER);
      expect(clusters).toHaveLength(0);
    });
  });

  // CASE STUDY 14: Generic Title Boilerplate & Conflicting Publisher DOI / Pagination Protection
  describe('Case Study 14: Generic Title Boilerplate & Conflicting Publisher DOI / Pagination Protection', () => {
    it('prevents false-positive clustering of generic "Editorial" items and same-author clinical reports with distinct publisher DOIs/pages, while clustering Preprint -> Published evolutions', async () => {
      const candidateItems = [
        // Two distinct Editorials by the Chief Editor in 2025
        {
          id: 'editorial-jan',
          title: 'Editorial',
          itemType: 'journalArticle',
          year: 2025,
          authors: ['Horton, Richard'],
          metadata: { issue: '1', pages: '1-2' },
        },
        {
          id: 'editorial-feb',
          title: 'Editorial',
          itemType: 'journalArticle',
          year: 2025,
          authors: ['Horton, Richard'],
          metadata: { issue: '2', pages: '101-102' },
        },
        // Two distinct published letters/reports by the same author in the same year with different publisher DOIs & pages
        {
          id: 'nejm-case-1',
          title:
            'Acute Myocarditis Following mRNA Vaccination: Clinical Outcomes',
          itemType: 'journalArticle',
          doi: '10.1056/NEJMc2400101',
          year: 2024,
          authors: ['Basso, Cristina'],
          metadata: { pages: '10-12' },
        },
        {
          id: 'nejm-case-2',
          title:
            'Acute Myocarditis Following mRNA Vaccination: Clinical Outcomes',
          itemType: 'journalArticle',
          doi: '10.1056/NEJMc2400999',
          year: 2024,
          authors: ['Basso, Cristina'],
          metadata: { pages: '450-452' },
        },
        // True Preprint -> Published evolution (arXiv DOI vs Nature DOI)
        {
          id: 'arxiv-preprint',
          title:
            'Scaling Laws for Neural Language Models in Low-Resource Regimes',
          itemType: 'preprint',
          doi: '10.48550/arXiv.2401.09999',
          arxivId: '2401.09999',
          year: 2024,
          authors: ['Kaplan, Jared'],
          metadata: {},
        },
        {
          id: 'nature-published',
          title:
            'Scaling Laws for Neural Language Models in Low-Resource Regimes',
          itemType: 'journalArticle',
          doi: '10.1038/s41586-024-09999-1',
          year: 2024,
          authors: ['Kaplan, Jared'],
          publicationTitle: 'Nature',
          abstract:
            'We study empirical scaling laws for language model performance.',
          metadata: { volume: '630', pages: '200-210' },
        },
      ];

      const { service: txService } = createMockTxService({});
      const mockCatalogGateway: Partial<ICatalogFacade> = {
        findDuplicateCandidateItems: jest.fn(
          async () => candidateItems,
        ) as unknown as ICatalogFacade['findDuplicateCandidateItems'],
        findByIds: jest.fn(async () => []),
        mergeItems: jest.fn(async () => undefined),
      };

      const duplicateService = createDuplicateService(
        txService,
        mockCatalogGateway as unknown as ICatalogFacade,
      );

      const clusters = await duplicateService.detectDuplicates(USER_OWNER);
      expect(clusters).toHaveLength(1);
      expect(clusters[0].items.map((i) => i.id)).toEqual([
        'arxiv-preprint',
        'nature-published',
      ]);
      // Zoplicate smart master recommendation prefers the published Nature journalArticle over the preprint
      expect(clusters[0].recommendedMasterId).toBe('nature-published');
    });
  });

  // CASE STUDY 15: Zoplicate recommendedMasterId & PRISMA 2020 Systematic Review Audit Trail
  describe('Case Study 15: Zoplicate recommendedMasterId & PRISMA 2020 Systematic Review Audit Trail', () => {
    it('outputs a complete, reproducible PRISMA 2020 audit summary from mergeDuplicates recording masterItemId, mergedDuplicateIds, matchReasons, preservedCitationKeys, and consolidated counts', async () => {
      const mockTx = {
        $executeRaw: jest.fn(async () => 1),
        itemRelation: {
          findMany: jest.fn(async () => []),
        },
        contributor: {
          count: jest.fn(async () => 2),
        },
        userPublication: {
          findMany: jest.fn(async () => []),
        },
        itemMetadata: {
          updateMany: jest.fn(async () => ({ count: 1 })),
        },
        item: {
          update: jest.fn(async ({ where, data }) => ({
            id: where.id,
            ...data,
            version: 2,
          })),
          findUnique: jest.fn(async () => ({
            id: 'master-pub',
            title:
              'PRISMA 2020 Statement: An Updated Guideline for Reporting Systematic Reviews',
            itemType: 'journalArticle',
            doi: '10.1136/bmj.n71',
            citationKey: 'page2021prisma',
            version: 2,
            contributors: [{ id: 'c1', fullName: 'Matthew J. Page' }],
            collectionItems: [
              { collectionId: 'col-1' },
              { collectionId: 'col-2' },
            ],
            itemTags: [{ tagId: 't-1' }, { tagId: 't-2' }, { tagId: 't-3' }],
            notesList: [{ id: 'n-1' }, { id: 'n-2' }],
            attachments: [{ id: 'att-1' }],
          })),
        },
      };

      const { service: txService } = createMockTxService(mockTx);
      const mockCatalogGateway: Partial<ICatalogFacade> = {
        findByIds: jest.fn(async () => [
          {
            id: 'master-pub',
            userId: USER_OWNER,
            projectId: PROJECT_A,
            itemType: 'journalArticle',
            title:
              'PRISMA 2020 Statement: An Updated Guideline for Reporting Systematic Reviews',
            doi: '10.1136/bmj.n71',
            citationKey: 'page2021prisma',
            year: 2021,
            metadata: {},
            version: 1,
            deletedAt: null,
          },
          {
            id: 'dup-medrxiv',
            userId: USER_OWNER,
            projectId: PROJECT_A,
            itemType: 'preprint',
            title:
              'PRISMA 2020 Statement: An Updated Guideline for Reporting Systematic Reviews',
            doi: '10.1136/bmj.n71',
            citationKey: 'page2020medrxiv',
            year: 2020,
            abstract:
              'The Preferred Reporting Items for Systematic reviews and Meta-Analyses (PRISMA) statement...',
            metadata: { pmid: '33782057' },
            version: 1,
            deletedAt: null,
          },
        ]) as unknown as ICatalogFacade['findByIds'],
        mergeItems: jest.fn(async () => undefined),
        findDuplicateCandidateItems: jest.fn(async () => []),
      };

      const mockExtractionGateway: IExtractionFacade = {
        reassignContentToItem: jest.fn(async () => undefined),
      } as unknown as IExtractionFacade;

      const duplicateService = createDuplicateService(
        txService,
        mockCatalogGateway as unknown as ICatalogFacade,
        mockExtractionGateway,
      );

      const mergeResult = await duplicateService.mergeDuplicates(
        USER_OWNER,
        {
          primaryItemId: 'master-pub',
          duplicateItemIds: ['dup-medrxiv'],
        },
        PROJECT_A,
      );

      expect(mergeResult.audit).toBeDefined();
      expect(mergeResult.audit).toEqual(
        expect.objectContaining({
          masterItemId: 'master-pub',
          mergedDuplicateIds: ['dup-medrxiv'],
          matchReasons: ['EXACT_DOI'],
          preservedCitationKeys: ['page2021prisma', 'page2020medrxiv'],
          consolidatedAttachments: 1,
          consolidatedNotes: 2,
          consolidatedTags: 3,
          consolidatedCollections: 2,
          backfilledFields: expect.arrayContaining(['abstract', 'pmid']),
          timestamp: expect.any(String),
        }),
      );
    });
  });

  // CASE STUDY 16: CurationController.dismissDuplicates Endpoint & 4-Role Guard Verification
  describe('Case Study 16: CurationController.dismissDuplicates HTTP Endpoint & 4-Role Guard', () => {
    it('exposes POST /duplicates/dismiss with @ProjectRoles(owner, coordinator, contributor) and delegates to DuplicateService.dismissDuplicates', async () => {
      const mockDuplicateService = {
        detectDuplicates: jest.fn(),
        mergeDuplicates: jest.fn(),
        dismissDuplicates: jest.fn(async (userId, itemIds, projectId) => ({
          dismissed: true,
          itemIds,
          scope: projectId,
          by: userId,
        })),
      } as unknown as DuplicateDetectorService & DuplicateMergerService;

      const mockQualityService = {
        getQualityAudit: jest.fn(),
      } as unknown as QualityService;

      const controller = new CurationController(
        mockDuplicateService as any,
        mockDuplicateService as any,
        mockQualityService,
      );

      // Verify @ProjectRoles decorator restricts mutation to owner, coordinator, contributor (excluding reviewer)
      const allowedRoles = Reflect.getMetadata(
        PROJECT_ROLES_KEY,
        CurationController.prototype.dismissDuplicates,
      );
      expect(allowedRoles).toEqual(['owner', 'coordinator', 'contributor']);

      const response = await controller.dismissDuplicates(
        USER_CONTRIB,
        { itemIds: ['item-1', 'item-2'] },
        undefined,
        PROJECT_A,
      );

      expect(mockDuplicateService.dismissDuplicates).toHaveBeenCalledWith(
        USER_CONTRIB,
        ['item-1', 'item-2'],
        PROJECT_A,
      );
      expect(response).toEqual(
        expect.objectContaining({
          dismissed: true,
          itemIds: ['item-1', 'item-2'],
        }),
      );
    });
  });
});
