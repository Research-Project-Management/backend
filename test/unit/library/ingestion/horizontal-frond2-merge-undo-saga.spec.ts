import { DuplicateDetectorService, getEffectiveItemField } from '@/modules/library/ingestion/services/duplicate-detector.service';
import { applyMergedUpdatesAndClearDuplicateCitationKeyCollision, rewireMergedItemRelations, syncMergedContributors, syncMergedIdentifiersInTx } from '@/modules/library/ingestion/domain/duplicate-merge.domain';
import { MetadataAndCreatorBackfillMergeStep, MergePipelineContext } from '@/modules/library/ingestion/domain/duplicate-merge.steps';
import { executeUndoDuplicateMergeInTx } from '@/modules/library/ingestion/domain/duplicate-merge.memento';
import { AttachmentsRepository } from '@/modules/library/extraction/repositories/attachments.repository';
import { StateService } from '@/modules/library/catalog/services/state.service';
import { buildImportItemPayload } from '@/modules/library/catalog/services/item-curation.service';

describe('Horizontal Frond 2 — Deduplication, Curation Merge & Undo-Merge Saga', () => {
  describe('Fix Area 1: Coupled Alias Backfill & Effective Field Resolution', () => {
    it('resolves coupled aliases in getEffectiveItemField across top-level columns and metadata', () => {
      const item = {
        id: 'item-1',
        abstract: 'Top-level canonical abstract',
        publicationTitle: 'Journal of Canonical Science',
        year: 2024,
        metadata: {},
      };

      expect(getEffectiveItemField(item, 'abstractNote')).toBe(
        'Top-level canonical abstract',
      );
      expect(getEffectiveItemField(item, 'journal')).toBe(
        'Journal of Canonical Science',
      );
      expect(getEffectiveItemField(item, 'proceedingsTitle')).toBe(
        'Journal of Canonical Science',
      );
      expect(getEffectiveItemField(item, 'date')).toBe(2024);

      const metaItem = {
        id: 'item-2',
        abstract: null,
        publicationTitle: null,
        year: null,
        metadata: {
          abstractNote: 'Metadata abstract note',
          bookTitle: 'Collected Works',
          publicationDate: '2023-05-10',
        },
      };

      expect(getEffectiveItemField(metaItem, 'abstract')).toBe(
        'Metadata abstract note',
      );
      expect(getEffectiveItemField(metaItem, 'publicationTitle')).toBe(
        'Collected Works',
      );
      expect(getEffectiveItemField(metaItem, 'year')).toBe('2023-05-10');
    });

    it('prevents duplicate alias backfillFields from overwriting existing Master canonical abstract, publicationTitle, and year', async () => {
      const mockTx = {
        item: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          update: jest.fn().mockResolvedValue({ id: 'master-1', version: 2 }),
        },
      } as any;

      const primary = {
        id: 'master-1',
        title: 'Master Title',
        abstract: 'Master Canonical Abstract',
        publicationTitle: 'Master Canonical Venue',
        year: 2025,
        doi: '10.1000/master',
        url: null,
        citationKey: 'master2025',
        metadata: {},
      };

      const primaryMeta: Record<string, unknown> = {
        abstractNote: 'Duplicate Stale Abstract Note',
        journal: 'Duplicate Stale Journal',
        date: '1999-01-01',
      };

      const { topLevelData } =
        await applyMergedUpdatesAndClearDuplicateCitationKeyCollision({
          tx: mockTx,
          primary,
          duplicates: [{ id: 'dup-1' }],
          effectiveMergedItemType: 'journalArticle',
          derivedFirstAuthor: 'Smith',
          noteCount: 0,
          attachmentCount: 0,
          backfillFields: {
            abstractNote: 'Duplicate Stale Abstract Note',
            journal: 'Duplicate Stale Journal',
            date: '1999-01-01',
          },
          scalarSelections: {},
          primaryMeta,
        });

      expect(topLevelData.abstract).toBeUndefined();
      expect(topLevelData.publicationTitle).toBeUndefined();
      expect(topLevelData.year).toBeUndefined();
      expect(primaryMeta.abstractNote).toBe('Master Canonical Abstract');
      expect(primaryMeta.publicationTitle).toBe('Master Canonical Venue');
      expect(primaryMeta.journal).toBeUndefined();
      expect(primaryMeta.date).toBeUndefined();
    });
  });

  describe('Fix Area 2: Master Placeholder Title Upgrade, Provenance Stamping & Master Recommendation Penalty', () => {
    it('penalizes placeholder/filename titles by -25 in DuplicateDetectorService.computeRecommendedMasterId', () => {
      const detector = new DuplicateDetectorService(
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      );

      const filenameItem = {
        id: 'item-filename',
        title: '2401.12345v1.pdf',
        doi: '10.1000/xyz',
        abstract: 'Some abstract',
        publicationTitle: 'Nature',
        year: 2024,
        hasFile: true,
        attachmentCount: 1,
        noteCount: 0,
        createdAt: new Date('2024-01-01T00:00:00Z'),
        metadata: { isFilenameTitle: true },
      };

      const realTitleItem = {
        id: 'item-clean',
        title: 'Attention Is All You Need: A Comprehensive Survey',
        doi: '10.1000/xyz',
        abstract: 'Some abstract',
        publicationTitle: 'Nature',
        year: 2024,
        hasFile: false,
        attachmentCount: 0,
        noteCount: 0,
        createdAt: new Date('2024-02-01T00:00:00Z'),
        metadata: {},
      };

      const recommended = (detector as any).computeRecommendedMasterId([
        filenameItem,
        realTitleItem,
      ]);
      expect(recommended).toBe('item-clean');
    });

    it('upgrades Master placeholder title from duplicate, clears isFilenameTitle, stamps scalarSelections provenance, and sorts backfill donors by authority', async () => {
      const step = new MetadataAndCreatorBackfillMergeStep();
      const mockTx = {
        contributor: {
          findMany: jest.fn().mockResolvedValue([]),
          deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
          createMany: jest.fn().mockResolvedValue({ count: 0 }),
          count: jest.fn().mockResolvedValue(0),
        },
        itemMetadata: {
          findMany: jest.fn().mockResolvedValue([]),
        },
        item: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          update: jest.fn().mockImplementation(async ({ data }) => ({
            id: 'master-1',
            ...data,
          })),
        },
      } as any;

      const primary = {
        id: 'master-1',
        title: 'Untitled Document.pdf',
        abstract: null,
        publicationTitle: null,
        year: 2024,
        doi: null,
        url: null,
        citationKey: null,
        metadata: {
          isFilenameTitle: true,
          fieldProvenance: {
            title: {
              source: 'GROBID',
              confidenceScore: 0.4,
              lockedByUser: false,
              isFilenameTitle: true,
              updatedAt: '2024-01-01T00:00:00.000Z',
            },
          },
        },
      };

      const lowAuthDup = {
        id: 'dup-low',
        title: 'Real Academic Title From Low Auth',
        abstract: 'Low authority abstract',
        metadata: {
          publisher: 'Low Auth Publisher',
          fieldProvenance: {
            publisher: {
              source: 'Heuristic',
              confidenceScore: 0.3,
              lockedByUser: false,
              updatedAt: '2024-01-01T00:00:00.000Z',
            },
          },
        },
      };

      const highAuthDup = {
        id: 'dup-high',
        title: 'Authoritative Crossref Title',
        abstract: 'High authority abstract',
        metadata: {
          publisher: 'Springer Nature',
          pmid: '99999999',
          fieldProvenance: {
            title: {
              source: 'Crossref',
              confidenceScore: 0.95,
              lockedByUser: false,
              updatedAt: '2024-01-02T00:00:00.000Z',
            },
            publisher: {
              source: 'Crossref',
              confidenceScore: 0.95,
              lockedByUser: false,
              updatedAt: '2024-01-02T00:00:00.000Z',
            },
          },
        },
      };

      const ctx: MergePipelineContext = {
        tx: mockTx,
        userId: 'user-1',
        primaryId: 'master-1',
        uniqueDupIds: ['dup-low', 'dup-high'],
        primary,
        duplicates: [lowAuthDup, highAuthDup],
        primaryMeta: { ...primary.metadata },
        rawSelections: {
          abstract: 'User Explicitly Chosen Abstract',
          pmid: '12345678',
        },
        scalarSelections: {
          abstract: 'User Explicitly Chosen Abstract',
          pmid: '12345678',
        },
        backfillFields: {},
        reassignedAttachmentIds: [],
        reassignedNoteIds: [],
      } as any;

      await step.execute(ctx);

      expect(ctx.backfillFields.title).toBe('Authoritative Crossref Title');
      expect(ctx.primaryMeta.isFilenameTitle).toBe(false);
      expect(ctx.backfillFields.publisher).toBe('Springer Nature');
      // IDENTIFIER_META_KEYS loop must NOT overwrite scalarSelections.pmid
      expect(ctx.primaryMeta.pmid).toBe('12345678');

      const prov = ctx.primaryMeta.fieldProvenance as Record<string, any>;
      expect(prov.abstract?.lockedByUser).toBe(true);
      expect(prov.abstractNote?.lockedByUser).toBe(true);
      expect(ctx.primaryMeta.lockedFields).toEqual(
        expect.arrayContaining(['abstract', 'abstractNote', 'pmid']),
      );
    });
  });

  describe('Fix Area 3: Relational Contributor & ItemIdentifier Synchronization', () => {
    it('upgrades Master contributors when duplicate has fuller given names or locked creators, and syncs primaryMeta.creators & authors', async () => {
      const mockTx = {
        contributor: {
          count: jest.fn().mockResolvedValue(1),
          deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
          createMany: jest.fn().mockResolvedValue({ count: 2 }),
        },
      } as any;

      const primary = {
        id: 'master-1',
        contributors: [
          {
            creatorType: 'author',
            fieldMode: 0,
            firstName: 'J.',
            lastName: 'Smith',
            fullName: 'J. Smith',
            shortName: 'J. Smith',
            orderIndex: 0,
          },
        ],
        metadata: {},
      };
      const primaryMeta: Record<string, unknown> = {};
      const duplicates = [
        {
          id: 'dup-1',
          contributors: [
            {
              creatorType: 'author',
              fieldMode: 0,
              firstName: 'Jonathan',
              lastName: 'Smith',
              fullName: 'Jonathan Smith',
              shortName: 'J. Smith',
              orderIndex: 0,
            },
            {
              creatorType: 'author',
              fieldMode: 0,
              firstName: 'Alice',
              lastName: 'Doe',
              fullName: 'Alice Doe',
              shortName: 'A. Doe',
              orderIndex: 1,
            },
          ],
          metadata: {
            lockedFields: ['creators'],
          },
        },
      ];

      await syncMergedContributors(
        mockTx,
        'master-1',
        undefined,
        duplicates,
        primary,
        primaryMeta,
      );

      expect(mockTx.contributor.deleteMany).toHaveBeenCalledWith({
        where: { itemId: 'master-1' },
      });
      expect(mockTx.contributor.createMany).toHaveBeenCalledTimes(1);
      expect(primaryMeta.creators).toEqual([
        expect.objectContaining({
          firstName: 'Jonathan',
          lastName: 'Smith',
          name: 'Jonathan Smith',
        }),
        expect.objectContaining({
          firstName: 'Alice',
          lastName: 'Doe',
          name: 'Alice Doe',
        }),
      ]);
      expect(primaryMeta.authors).toEqual(['Jonathan Smith', 'Alice Doe']);
    });

    it('normalizes canonicalIdType, deletes duplicate identifiers BEFORE upserting on Master, and backfills discovered identifiers into primaryMeta', async () => {
      const callOrder: string[] = [];
      const mockTx = {
        itemIdentifier: {
          findMany: jest.fn().mockImplementation(async () => {
            callOrder.push('findMany');
            return [
              {
                itemId: 'dup-1',
                type: 'ARXIVID',
                value: '2405.99999',
                canonicalUri: 'arxiv:2405.99999',
              },
              {
                itemId: 'dup-1',
                type: 'PMID',
                value: '87654321',
                canonicalUri: 'pmid:87654321',
              },
              {
                itemId: 'dup-1',
                type: 'DOI',
                value: '10.1038/s41586-024-00001-x',
                canonicalUri: 'https://doi.org/10.1038/s41586-024-00001-x',
              },
            ];
          }),
          deleteMany: jest.fn().mockImplementation(async () => {
            callOrder.push('deleteMany');
            return { count: 3 };
          }),
          upsert: jest.fn().mockImplementation(async () => {
            callOrder.push('upsert');
            return {};
          }),
        },
      } as any;

      const primaryMeta: Record<string, unknown> = {};
      const topLevelData: Record<string, unknown> = {};

      await syncMergedIdentifiersInTx({
        tx: mockTx,
        primaryId: 'master-1',
        uniqueDupIds: ['dup-1'],
        primaryMeta,
        topLevelData,
        primaryDoi: null,
      });

      // Must delete duplicate rows before upserting onto Master to avoid @@unique([type, value]) violation
      expect(callOrder.indexOf('deleteMany')).toBeGreaterThan(-1);
      expect(callOrder.indexOf('upsert')).toBeGreaterThan(
        callOrder.indexOf('deleteMany'),
      );

      const upsertedTypes = mockTx.itemIdentifier.upsert.mock.calls.map(
        (c: any) => c[0].where.itemId_type.type,
      );
      expect(upsertedTypes).toEqual(
        expect.arrayContaining(['arxiv', 'pmid', 'doi']),
      );
      expect(primaryMeta.arxivId).toBe('2405.99999');
      expect(primaryMeta.pmid).toBe('87654321');
      expect(primaryMeta.doi).toBe('10.1038/s41586-024-00001-x');
      expect(topLevelData.doi).toBe('10.1038/s41586-024-00001-x');
    });
  });

  describe('Fix Area 4: Reciprocal Relations, Soft-Delete Annotations, Undo-Merge Saga & Curation Payload', () => {
    it('deduplicates reciprocal inverse ItemRelation edges when rewiring duplicate relations onto Master', async () => {
      const mockTx = {
        itemRelation: {
          deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
          findMany: jest.fn().mockResolvedValue([
            // Master already has: master-1 cites item-target
            {
              id: 'rel-master-1',
              sourceItemId: 'master-1',
              targetItemId: 'item-target',
              relationType: 'cites',
            },
            // Duplicate has reciprocal inverse: item-target cited_by dup-1
            {
              id: 'rel-dup-inverse',
              sourceItemId: 'item-target',
              targetItemId: 'dup-1',
              relationType: 'cited_by',
            },
          ]),
          update: jest.fn().mockResolvedValue({}),
        },
      } as any;

      await rewireMergedItemRelations(mockTx, 'master-1', ['dup-1']);

      // Should delete the redundant inverse relation instead of updating it to point to master-1
      expect(mockTx.itemRelation.update).not.toHaveBeenCalled();
      expect(mockTx.itemRelation.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['rel-dup-inverse'] } },
      });
    });

    it('soft-deletes redundant duplicate annotations during AttachmentsRepository.reassignToItem', async () => {
      const repo = new AttachmentsRepository({} as any);
      const mockTx = {
        attachment: {
          findMany: jest.fn().mockResolvedValue([
            // Existing on target
            {
              id: 'att-master',
              itemId: 'master-1',
              fileHash: 'hash-same',
              size: 1024,
              filename: 'paper.pdf',
              mimeType: 'application/pdf',
            },
            // Source attachment with same hash
            {
              id: 'att-dup',
              itemId: 'dup-1',
              fileHash: 'hash-same',
              size: 1024,
              filename: 'paper.pdf',
              mimeType: 'application/pdf',
            },
          ]),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        annotation: {
          findMany: jest
            .fn()
            .mockResolvedValueOnce([
              {
                id: 'ann-master-existing',
                pageIndex: 1,
                quoteText: 'Same quote',
                comment: 'Same comment',
                type: 'highlight',
              },
            ])
            .mockResolvedValueOnce([
              {
                id: 'ann-dup-redundant',
                pageIndex: 1,
                quoteText: 'Same quote',
                comment: 'Same comment',
                type: 'highlight',
              },
            ]),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      } as any;

      await repo.reassignToItem(['dup-1'], 'master-1', mockTx);

      expect(mockTx.annotation.deleteMany).not.toHaveBeenCalled();
      expect(mockTx.annotation.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['ann-dup-redundant'] } },
          data: expect.objectContaining({
            deletedAt: expect.any(Date),
            version: { increment: 1 },
          }),
        }),
      );
    });

    it('restores Master and Duplicate attachmentCount/noteCount, UserItemState timestamps, and handles missing annotations on undoMerge', async () => {
      const updateManyAnnot = jest.fn().mockResolvedValue({ count: 0 });
      const createManyState = jest.fn().mockResolvedValue({ count: 1 });
      const itemUpdateMany = jest.fn().mockResolvedValue({ count: 1 });

      const mockTx = {
        item: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'master-1',
            userId: 'user-1',
            projectId: null,
            metadata: {
              lastMergeMemento: {
                schemaVersion: 3,
                masterItemId: 'master-1',
                mergedDuplicateIds: ['dup-1'],
                capturedAt: '2025-01-01T00:00:00.000Z',
                beforeMaster: {
                  id: 'master-1',
                  title: 'Master Before',
                  userStates: [
                    {
                      userId: 'user-1',
                      isStarred: true,
                      readStatus: 'reading',
                      currentPage: 5,
                      lastOpenedAt: '2025-01-01T10:00:00.000Z',
                      lastReadAt: '2025-01-01T11:00:00.000Z',
                    },
                  ],
                  annotations: [
                    {
                      id: 'missing-ann-id',
                      attachmentId: 'att-master',
                      deletedAt: null,
                    },
                  ],
                },
                mergedDuplicates: [
                  {
                    id: 'dup-1',
                    title: 'Dup 1 Before',
                    attachmentIds: ['att-dup-1'],
                    noteIds: ['note-dup-1'],
                    userStates: [
                      {
                        userId: 'user-1',
                        isStarred: false,
                        readStatus: 'completed',
                        currentPage: 12,
                        lastOpenedAt: '2025-01-02T10:00:00.000Z',
                        lastReadAt: '2025-01-02T11:00:00.000Z',
                      },
                    ],
                  },
                ],
              },
            },
          }),
          findFirst: jest.fn().mockResolvedValue({
            id: 'master-1',
            userId: 'user-1',
            projectId: null,
            metadata: {},
          }),
          update: jest.fn().mockImplementation(async ({ where, data }) => ({
            id: where.id,
            version: 2,
            ...data,
          })),
          updateMany: itemUpdateMany,
        },
        attachment: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          count: jest
            .fn()
            .mockImplementation(async ({ where }) =>
              where.itemId === 'master-1' ? 1 : 2,
            ),
        },
        note: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          count: jest
            .fn()
            .mockImplementation(async ({ where }) =>
              where.itemId === 'master-1' ? 3 : 4,
            ),
        },
        annotation: {
          updateMany: updateManyAnnot,
        },
        state: {
          deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
          createMany: createManyState,
        },
      } as any;

      const helpers = {
        appendChange: jest.fn().mockResolvedValue(undefined),
        publishOutbox: jest.fn().mockResolvedValue(undefined),
        removeTombstonesBatch: jest.fn().mockResolvedValue(undefined),
      } as any;

      const res = await executeUndoDuplicateMergeInTx({
        tx: mockTx,
        helpers,
        userId: 'user-1',
        primaryItemId: 'master-1',
      });

      expect(res.restoredPrimaryId).toBe('master-1');
      expect(res.restoredDuplicateIds).toEqual(['dup-1']);
      expect(updateManyAnnot).toHaveBeenCalledWith({
        where: { id: 'missing-ann-id' },
        data: { attachmentId: 'att-master', deletedAt: null },
      });

      // Verify state restoration preserved lastOpenedAt and lastReadAt for both master and duplicate
      expect(createManyState).toHaveBeenCalledTimes(2);
      expect(createManyState.mock.calls[0][0].data[0]).toEqual(
        expect.objectContaining({
          itemId: 'master-1',
          lastOpenedAt: new Date('2025-01-01T10:00:00.000Z'),
          lastReadAt: new Date('2025-01-01T11:00:00.000Z'),
        }),
      );
      expect(createManyState.mock.calls[1][0].data[0]).toEqual(
        expect.objectContaining({
          itemId: 'dup-1',
          lastOpenedAt: new Date('2025-01-02T10:00:00.000Z'),
          lastReadAt: new Date('2025-01-02T11:00:00.000Z'),
        }),
      );

      // Verify both dup-1 and master-1 had their attachmentCount and noteCount recounted after unmerge
      expect(itemUpdateMany).toHaveBeenCalledWith({
        where: { id: 'dup-1' },
        data: { hasFile: true, attachmentCount: 2, noteCount: 4 },
      });
      expect(itemUpdateMany).toHaveBeenCalledWith({
        where: { id: 'master-1' },
        data: { hasFile: true, attachmentCount: 1, noteCount: 3 },
      });
    });

    it('preserves maxCurrentPage = null in StateService.transferUserItemStates when all states have null/0 currentPage', async () => {
      const stateService = new StateService({} as any, {} as any);
      const mockTx = {
        state: {
          findMany: jest.fn().mockResolvedValue([
            {
              userId: 'user-1',
              itemId: 'dup-1',
              isStarred: true,
              rating: null,
              readStatus: 'unread',
              currentPage: null,
              scrollPosition: null,
              lastOpenedAt: null,
              lastReadAt: null,
            },
          ]),
          upsert: jest.fn().mockResolvedValue({}),
          deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      } as any;

      await stateService.transferUserItemStates(
        mockTx,
        ['dup-1'],
        'master-1',
      );

      expect(mockTx.state.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ currentPage: null }),
          update: expect.objectContaining({ currentPage: null }),
        }),
      );
    });

    it('preserves edition, seriesNumber, accessedAt, retraction fields, fieldProvenance, and lockedFields in buildImportItemPayload', () => {
      const payload = buildImportItemPayload(
        {
          title: 'Imported Paper',
          edition: '2nd Edition',
          seriesNumber: 'Vol. 42',
          accessedAt: '2025-02-01T00:00:00.000Z',
          isRetracted: true,
          retractionNature: 'Retraction',
          retractionDetails: 'Data fabrication',
          retractionCheckedAt: '2025-02-02T00:00:00.000Z',
          fieldProvenance: {
            title: { source: 'Crossref', confidenceScore: 0.95 },
          },
          lockedFields: ['title'],
        },
        'user-1',
      );

      expect(payload).toEqual(
        expect.objectContaining({
          edition: '2nd Edition',
          seriesNumber: 'Vol. 42',
          accessedAt: '2025-02-01T00:00:00.000Z',
          isRetracted: true,
          retractionNature: 'Retraction',
          retractionDetails: 'Data fabrication',
          retractionCheckedAt: '2025-02-02T00:00:00.000Z',
          fieldProvenance: {
            title: { source: 'Crossref', confidenceScore: 0.95 },
          },
          lockedFields: ['title'],
        }),
      );
    });
  });
});
