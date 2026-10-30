import { DuplicateDetectorService } from '@/modules/library/ingestion/services/duplicate-detector.service';
import { DuplicateMergerService } from '@/modules/library/ingestion/services/duplicate-merger.service';
import { TypesService } from '@/modules/library/catalog/services/types.service';
import { ItemTransformer } from '@/modules/library/catalog/domain/item.transformer';
import {
  ItemTypeConversionService,
  buildTypeConversionUpdatePayload,
} from '@/modules/library/catalog/services/item-type-conversion.service';
import {
  buildCommandUpdateInput,
  resolveCanonicalCommandFields,
  buildMetadataPartial,
  normalizeItemIdentifiers,
} from '@/modules/library/catalog/domain/command-payload.builder';
import { ItemsMapper } from '@/modules/library/catalog/domain/items.mapper';
import { ItemDetail, UpdateItemData } from '@/modules/library/core/types/bibliographic.types';

describe('System Design Loop 2 — Duplicate Merge/Undo Saga & Item Type Conversion Backend', () => {
  const userId = '11111111-1111-4111-8111-111111111111';

  describe('SD1-09 & SD2-04: DuplicateDetectorService', () => {
    it('SD2-04: detects relational identifiers (ItemIdentifier[]) and checks relational DOIs for Tier-2 conflicts', async () => {
      const itemA = {
        id: 'item-a',
        userId,
        title: 'Quantum Computing Advances in 2025',
        firstAuthor: 'Smith',
        year: 2025,
        itemType: 'journalArticle',
        identifiers: [{ type: 'arxiv', value: '2501.12345' }],
        metadata: {},
      };
      const itemB = {
        id: 'item-b',
        userId,
        title: 'Quantum Computing Advances in 2025',
        firstAuthor: 'Smith',
        year: 2025,
        itemType: 'preprint',
        identifiers: [{ type: 'arxiv', value: 'arXiv:2501.12345v2' }],
        metadata: {},
      };
      const mockCatalogGateway = {
        findDuplicateCandidateItems: jest.fn().mockResolvedValue([itemA, itemB]),
        findByIds: jest.fn().mockResolvedValue([itemA, itemB]),
      };
      const detector = new DuplicateDetectorService(
        mockCatalogGateway as never,
      );

      const clusters = await detector.detectDuplicates(userId);
      expect(clusters).toHaveLength(1);
      expect(clusters[0].matchReason).toBe('EXACT_ARXIV');

      // Conflicting relational DOIs must veto Tier-2 fuzzy title match
      const itemC = {
        id: 'item-c',
        userId,
        title: 'Deep Neural Networks for Molecular Property Prediction',
        firstAuthor: 'Lee',
        year: 2024,
        itemType: 'journalArticle',
        identifiers: [{ type: 'doi', value: '10.1038/s41586-024-00001-1' }],
        metadata: {},
      };
      const itemD = {
        id: 'item-d',
        userId,
        title: 'Deep Neural Networks for Molecular Property Prediction',
        firstAuthor: 'Lee',
        year: 2024,
        itemType: 'journalArticle',
        identifiers: [{ type: 'doi', value: '10.1038/s41586-024-99999-9' }],
        metadata: {},
      };
      mockCatalogGateway.findDuplicateCandidateItems.mockResolvedValueOnce([itemC, itemD]);
      mockCatalogGateway.findByIds.mockResolvedValueOnce([itemC, itemD]);

      const conflictingClusters = await detector.detectDuplicates(userId);
      expect(conflictingClusters).toHaveLength(0);
    });

    it('SD1-09: dismissDuplicates includes full relations on tx.item.update and preserves relations in appendChange', async () => {
      const hydratedA = {
        id: 'item-1',
        userId,
        version: 2,
        title: 'Primary Paper',
        itemType: 'journalArticle',
        metadata: {},
        contributors: [{ id: 'c-1', name: 'Alice Smith', role: 'author', orderIndex: 0 }],
        collectionItems: [{ collectionId: 'col-1', sortOrder: 0 }],
        itemTags: [{ tagId: 'tag-1', tag: { id: 'tag-1', name: 'ML' } }],
        attachments: [{ id: 'att-1', filename: 'paper.pdf' }],
        identifiers: [{ id: 'id-1', type: 'doi', value: '10.1000/test' }],
        states: [{ userId, isRead: true, isFavorite: true }],
      };
      const hydratedB = {
        ...hydratedA,
        id: 'item-2',
        title: 'Secondary Paper',
      };

      const updateCalls: Array<Record<string, unknown>> = [];
      const mockTx = {
        item: {
          update: jest.fn().mockImplementation(async (args: Record<string, unknown>) => {
            updateCalls.push(args);
            const where = args.where as { id: string };
            const base = where.id === 'item-1' ? hydratedA : hydratedB;
            return {
              ...base,
              version: base.version + 1,
              metadata: (args.data as Record<string, unknown>).metadata,
            };
          }),
        },
      };
      const changeEntries: Array<Record<string, unknown>> = [];
      const mockHelpers = {
        appendChange: jest.fn().mockImplementation(async (_scope: unknown, entry: Record<string, unknown>) => {
          changeEntries.push(entry);
        }),
        publishOutbox: jest.fn().mockResolvedValue(undefined),
      };
      const mockLibraryTx = {
        executeInTransaction: jest.fn().mockImplementation(async (cb: (tx: unknown, helpers: unknown) => Promise<unknown>) =>
          cb(mockTx, mockHelpers),
        ),
      };
      const mockCatalogGateway = {
        findByIds: jest.fn().mockResolvedValue([hydratedA, hydratedB]),
      };

      const detector = new DuplicateDetectorService(
        mockCatalogGateway as never,
        undefined,
        mockLibraryTx as never,
      );
      const res = await detector.dismissDuplicates(userId, ['item-1', 'item-2']);
      expect(res.dismissed).toBe(true);
      expect(updateCalls).toHaveLength(2);
      expect(updateCalls[0].include).toEqual(
        expect.objectContaining({
          contributors: { orderBy: { orderIndex: 'asc' } },
          collectionItems: { include: { collection: true } },
          itemTags: { include: { tag: true } },
          notesList: { where: { deletedAt: null } },
          attachments: { include: { revisions: true } },
          identifiers: true,
          states: { where: { userId }, take: 1 },
        }),
      );
      expect(changeEntries).toHaveLength(2);
      const firstChangeData = changeEntries[0].data as Record<string, unknown>;
      expect(firstChangeData.creators).toEqual(
        expect.arrayContaining([expect.objectContaining({ fullName: 'Alice Smith' })]),
      );
      expect(firstChangeData.collectionIds).toEqual(['col-1']);
      expect(firstChangeData.tags).toEqual(['ML']);
    });
  });

  describe('SD2-09, SD2-10, SD3-04, SD3-05, SD3-06, SD3-07: DuplicateMergerService & Undo Saga', () => {
    const buildMergeHarness = () => {
      const primaryItem = {
        id: 'primary-1', userId, version: 1, title: 'Primary Title', itemType: 'patent',
        year: 2021, doi: '10.1000/old-doi', publicationTitle: 'Old Venue', abstract: 'Old abstract',
        firstAuthor: 'OldInventor', hasFile: false, attachmentCount: 0, noteCount: 0,
        metadata: {
          year: 2021, date: '2021-01-01', publicationDate: '2021-01-01',
          doi: '10.1000/old-doi', isbn: '978-3-16-148410-0',
          publicationTitle: 'Old Venue', journal: 'Old Venue',
          lockedFields: ['year', 'doi', 'isbn', 'publicationTitle'],
          fieldProvenance: {
            year: { source: 'UserOverride', isUserOverride: true },
            doi: { source: 'UserOverride', isUserOverride: true },
          },
        },
        contributors: [{ id: 'c-p1', name: 'OldInventor', role: 'inventor', sortOrder: 0 }],
        collectionItems: [], itemTags: [], attachments: [], notesList: [],
        identifiers: [
          { id: 'ident-doi', itemId: 'primary-1', type: 'doi', value: '10.1000/old-doi' },
          { id: 'ident-isbn', itemId: 'primary-1', type: 'isbn', value: '9783161484100' },
        ],
        states: [{ id: 'st-p1', itemId: 'primary-1', userId, isStarred: true, readStatus: 'read', rating: 5 }],
      };

      const dupItem = {
        id: 'dup-1', userId, version: 3, title: 'Dup Title', itemType: 'patent',
        year: 2022, doi: null, publicationTitle: null, abstract: null,
        firstAuthor: 'NewInventor', hasFile: true, attachmentCount: 1, noteCount: 1,
        metadata: {},
        contributors: [{ id: 'c-d1', name: 'Ada Lovelace', role: 'inventor', sortOrder: 0 }],
        collectionItems: [{ id: 'ci-d1', itemId: 'dup-1', collectionId: 'col-dup', sortOrder: 0 }],
        itemTags: [{ id: 'it-d1', itemId: 'dup-1', tagId: 'tag-dup', type: 'manual', tag: { id: 'tag-dup', name: 'PatentTag' } }],
        attachments: [{ id: 'att-d1', itemId: 'dup-1', fileId: 'file-d1', filename: 'spec.pdf', attachmentType: 'primary_pdf', deletedAt: null }],
        notesList: [{ id: 'note-d1', itemId: 'dup-1', userId, title: 'Lab Note', content: 'Important claim', deletedAt: null }],
        identifiers: [], states: [],
      };

      const itemMetadataRows = [
        { id: 'im-primary-crossref', itemId: 'primary-1', sourceProvider: 'crossref', rawTitle: 'Primary Title', offloadedFileId: 'off-1' },
        { id: 'im-dup-crossref', itemId: 'dup-1', sourceProvider: 'crossref', rawTitle: 'Dup Title', offloadedFileId: 'off-2' },
        { id: 'im-dup-openalex', itemId: 'dup-1', sourceProvider: 'openalex', rawTitle: 'Dup OpenAlex', offloadedFileId: 'off-3' },
      ];

      let updatedPrimaryRecord: Record<string, unknown> = { ...primaryItem };

      const tx = {
        $executeRaw: jest.fn().mockResolvedValue(1),
        item: {
          findMany: jest.fn().mockImplementation(async (args: { where?: { id?: { in?: string[] } } }) => {
            const ids = args?.where?.id?.in || [];
            return ids.includes('primary-1') && ids.includes('dup-1') ? [primaryItem, dupItem] : [dupItem];
          }),
          findFirst: jest.fn().mockImplementation(async (args?: { where?: { id?: string } }) =>
            args?.where?.id === 'dup-1' ? dupItem : updatedPrimaryRecord,
          ),
          findUnique: jest.fn().mockImplementation(async (args?: { where?: { id?: string } }) =>
            args?.where?.id === 'primary-1' ? updatedPrimaryRecord : args?.where?.id === 'dup-1' ? dupItem : null,
          ),
          update: jest.fn().mockImplementation(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
            if (args.where.id === 'primary-1') {
              updatedPrimaryRecord = {
                ...updatedPrimaryRecord, ...args.data, version: 2,
                contributors: [{ id: 'c-new', name: 'Ada Lovelace', role: 'inventor', sortOrder: 0 }],
                identifiers: [], states: primaryItem.states,
              };
              return updatedPrimaryRecord;
            }
            return { ...dupItem, ...args.data, version: 4 };
          }),
        },
        itemMetadata: {
          findMany: jest.fn().mockImplementation(async (args?: { where?: { itemId?: string | { in?: string[] } } }) => {
            const idFilter = args?.where?.itemId;
            if (typeof idFilter === 'string') {
              return itemMetadataRows.filter((r) => r.itemId === idFilter);
            }
            if (idFilter && typeof idFilter === 'object' && Array.isArray(idFilter.in)) {
              return itemMetadataRows.filter((r) => idFilter.in!.includes(r.itemId));
            }
            return itemMetadataRows;
          }),
          update: jest.fn().mockResolvedValue({}),
          delete: jest.fn().mockResolvedValue({}),
          deleteMany: jest.fn().mockResolvedValue({}),
        },
        contributor: { deleteMany: jest.fn().mockResolvedValue({}), createMany: jest.fn().mockResolvedValue({}), count: jest.fn().mockResolvedValue(1), findMany: jest.fn().mockResolvedValue(primaryItem.contributors) },
        itemContributor: { deleteMany: jest.fn().mockResolvedValue({}), createMany: jest.fn().mockResolvedValue({}) },
        itemIdentifier: {
          findMany: jest.fn().mockResolvedValue(primaryItem.identifiers),
          deleteMany: jest.fn().mockResolvedValue({}),
          upsert: jest.fn().mockResolvedValue({}),
          createMany: jest.fn().mockResolvedValue({}),
        },
        collectionItem: { deleteMany: jest.fn().mockResolvedValue({}), createMany: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue(dupItem.collectionItems) },
        itemTag: { deleteMany: jest.fn().mockResolvedValue({}), createMany: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue(dupItem.itemTags) },
        attachment: {
          findMany: jest.fn().mockResolvedValue(dupItem.attachments),
          updateMany: jest.fn().mockResolvedValue({}),
          count: jest.fn().mockResolvedValue(1),
          findFirst: jest.fn().mockResolvedValue({ id: 'att-d1', fileId: 'file-d1' }),
        },
        note: {
          findMany: jest.fn().mockResolvedValue(dupItem.notesList),
          updateMany: jest.fn().mockResolvedValue({}),
          count: jest.fn().mockResolvedValue(1),
        },
        annotation: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn().mockResolvedValue({}) },
        projectItem: { findMany: jest.fn().mockResolvedValue([]) },
        readingListsItem: { findMany: jest.fn().mockResolvedValue([]) },
        userItemState: {
          findMany: jest.fn().mockResolvedValue(primaryItem.states),
          upsert: jest.fn().mockResolvedValue({}),
          deleteMany: jest.fn().mockResolvedValue({}),
        },
        citationLink: { findMany: jest.fn().mockResolvedValue([]) },
        writingDocumentCitation: { findMany: jest.fn().mockResolvedValue([]) },
        canvasNode: { findMany: jest.fn().mockResolvedValue([]) },
        itemRelation: { findMany: jest.fn().mockResolvedValue([]) },
        userPublication: { findMany: jest.fn().mockResolvedValue([]) },
        itemHistory: {
          create: jest.fn().mockResolvedValue({ id: 'hist-1' }),
          findFirst: jest.fn().mockResolvedValue(null),
        },
      };

      const changeEvents: Array<Record<string, unknown>> = [];
      const outboxEvents: Array<{ id: string; eventType: string; payload: Record<string, unknown> }> = [];
      const helpers = {
        appendChange: jest.fn().mockImplementation(async (_scope: unknown, entry: Record<string, unknown>) => {
          changeEvents.push(entry);
        }),
        publishOutbox: jest.fn().mockImplementation(async (_scope: unknown, id: string, eventType: string, payload: Record<string, unknown>) => {
          outboxEvents.push({ id, eventType, payload });
        }),
        recordTombstone: jest.fn().mockResolvedValue(undefined),
      };
      const libraryTx = {
        executeInTransaction: jest.fn().mockImplementation(async (cb: (t: unknown, h: unknown) => Promise<unknown>) =>
          cb(tx, helpers),
        ),
      };
      const catalogGateway = {
        findByIds: jest.fn().mockResolvedValue([primaryItem, dupItem]),
        mergeItems: jest.fn().mockResolvedValue(undefined),
      };
      const storageService = {
        deleteFile: jest.fn().mockResolvedValue(undefined),
      };

      const merger = new DuplicateMergerService(
        libraryTx as never,
        catalogGateway as never,
        undefined,
        undefined,
        storageService as never,
      );

      return { merger, tx, helpers, storageService, changeEvents, outboxEvents };
    };

    it('SD3-04: rejects SYSTEM_RESERVED_MERGE_KEYS inside fieldSelections.extraFields and never persists nested extraFields/metadata into Item.metadata', async () => {
      const { merger, tx } = buildMergeHarness();

      await expect(
        merger.mergeDuplicates(userId, {
          primaryItemId: 'primary-1',
          duplicateItemIds: ['dup-1'],
          fieldSelections: {
            extraFields: { userId: 'attacker-id' },
          },
        }),
      ).rejects.toThrow(/system-reserved key/);

      await merger.mergeDuplicates(userId, {
        primaryItemId: 'primary-1',
        duplicateItemIds: ['dup-1'],
        fieldSelections: {
          extraFields: {
            patentNumber: 'US-9999999-B2',
            issuingAuthority: 'USPTO',
          },
        },
      });

      const primaryUpdateCall = tx.item.update.mock.calls.find(
        (c: Array<{ where: { id: string } }>) => c[0].where.id === 'primary-1',
      )?.[0] as { data: { metadata: Record<string, unknown> } };
      expect(primaryUpdateCall).toBeDefined();
      expect(primaryUpdateCall.data.metadata.patentNumber).toBe('US-9999999-B2');
      expect(primaryUpdateCall.data.metadata.issuingAuthority).toBe('USPTO');
      expect(primaryUpdateCall.data.metadata.extraFields).toBeUndefined();
      expect(primaryUpdateCall.data.metadata.metadata).toBeUndefined();

      // Also verify ItemsMapper.toDomain does not let a legacy nested metadata.extraFields wipe out extra parsing
      const mapped = ItemsMapper.toDomain({
        id: 'legacy-1',
        title: 'Legacy',
        itemType: 'patent',
        extra: 'Call Number: QA76.1',
        metadata: {
          patentNumber: 'US-123',
          extraFields: { status: 'Granted' },
        },
      });
      expect(mapped.extraFields).toEqual(
        expect.objectContaining({
          patentNumber: 'US-123',
          status: 'Granted',
          callNumber: 'QA76.1',
        }),
      );
    });

    it('SD2-09, SD2-10, SD3-05, SD3-06, SD3-07: consolidates ItemMetadata per sourceProvider without deleting files, clears scalars/identifiers cleanly, and recomputes firstAuthor for non-author types', async () => {
      const { merger, tx, storageService, changeEvents, outboxEvents } = buildMergeHarness();

      const mergeResult = await merger.mergeDuplicates(userId, {
        primaryItemId: 'primary-1',
        duplicateItemIds: ['dup-1'],
        fieldSelections: {
          creators: [{ firstName: 'Ada', lastName: 'Lovelace', creatorType: 'inventor' }],
          year: '',
          publicationTitle: '',
          doi: '',
          isbn: null,
        },
      });

      // SD2-09: Only 'openalex' (missing on primary) is reassigned; 'crossref' stays on dup-1; zero hard deletes or file deletions
      expect(tx.itemMetadata.update).toHaveBeenCalledTimes(1);
      expect(tx.itemMetadata.update).toHaveBeenCalledWith({
        where: { id: 'im-dup-openalex' },
        data: { itemId: 'primary-1' },
      });
      expect(tx.itemMetadata.delete).not.toHaveBeenCalled();
      expect(tx.itemMetadata.deleteMany).not.toHaveBeenCalled();
      expect(storageService.deleteFile).not.toHaveBeenCalled();

      // SD3-05 & SD3-07: Cleared year, publicationTitle, doi, isbn set top-level columns to null, delete metadata keys, unlock fields, and delete ItemIdentifier rows
      const primaryUpdateCall = tx.item.update.mock.calls.find(
        (c: Array<{ where: { id: string } }>) => c[0].where.id === 'primary-1',
      )?.[0] as { data: Record<string, unknown> };
      expect(primaryUpdateCall.data.year).toBeNull();
      expect(primaryUpdateCall.data.publicationTitle).toBeNull();
      expect(primaryUpdateCall.data.doi).toBeNull();
      // SD3-06: firstAuthor derived using patent primary creator role ('inventor')
      expect(primaryUpdateCall.data.firstAuthor).toBe('Lovelace');

      const updatedMeta = primaryUpdateCall.data.metadata as Record<string, unknown>;
      expect(updatedMeta.year).toBeUndefined();
      expect(updatedMeta.date).toBeUndefined();
      expect(updatedMeta.publicationDate).toBeUndefined();
      expect(updatedMeta.publicationTitle).toBeUndefined();
      expect(updatedMeta.journal).toBeUndefined();
      expect(updatedMeta.doi).toBeUndefined();
      expect(updatedMeta.isbn).toBeUndefined();
      expect(updatedMeta.lockedFields).toEqual([]);

      expect(tx.itemIdentifier.deleteMany).toHaveBeenCalledWith({
        where: {
          itemId: 'primary-1',
          type: { in: expect.arrayContaining(['doi', 'isbn']) },
        },
      });

      // SD2-10: reloadedPrimary preserves user state (isStarred/readStatus/rating) and returns mapped domain primaryItem
      expect(mergeResult.primaryItem).toEqual(
        expect.objectContaining({
          id: 'primary-1',
          isStarred: true,
          readStatus: 'read',
          rating: 5,
        }),
      );
    });
  });

  describe('SD3-02 & SD3-03: CommandPayloadBuilder Bidirectional Base Fields & Editors Sync', () => {
    it('SD3-02: updates and clears coupled base fields when type-specific fields are updated or cleared', () => {
      const existingCase: Partial<ItemDetail> = {
        id: 'case-1', itemType: 'case', title: 'Roe v. Wade',
        publicationTitle: 'U.S. Reports', year: 1973,
        metadata: {
          caseName: 'Roe v. Wade', reporter: 'U.S. Reports', publicationTitle: 'U.S. Reports',
          reporterVolume: '410', volume: '410', firstPage: '113', pages: '113',
          court: 'Supreme Court', publisher: 'Supreme Court', authority: 'Supreme Court',
          docketNumber: '70-18', issue: '70-18', number: '70-18',
          dateDecided: '1973-01-22', date: '1973-01-22', publicationDate: '1973-01-22',
        },
      };

      const updated = buildCommandUpdateInput(userId, existingCase as ItemDetail, {
        reporter: 'Supreme Court Reporter', reporterVolume: '93', firstPage: '705',
        court: 'SCOTUS', docketNumber: 'No. 70-18', dateDecided: '1974-05-01',
      } as UpdateItemData);

      const updatedMeta = updated.updateData.metadata as Record<string, unknown>;
      expect(updated.updateData.publicationTitle).toBe('Supreme Court Reporter');
      expect(updated.updateData.year).toBe(1974);
      expect(updatedMeta.publicationTitle).toBe('Supreme Court Reporter');
      expect(updatedMeta.reporter).toBe('Supreme Court Reporter');
      expect(updatedMeta.volume).toBe('93');
      expect(updatedMeta.reporterVolume).toBe('93');
      expect(updatedMeta.pages).toBe('705');
      expect(updatedMeta.firstPage).toBe('705');
      expect(updatedMeta.authority).toBe('SCOTUS');
      expect(updatedMeta.court).toBe('SCOTUS');
      expect(updatedMeta.issue).toBe('No. 70-18');
      expect(updatedMeta.number).toBe('No. 70-18');
      expect(updatedMeta.docketNumber).toBe('No. 70-18');
      expect(updatedMeta.date).toBe('1974-05-01');
      expect(updatedMeta.publicationDate).toBe('1974-05-01');

      const cleared = buildCommandUpdateInput(userId, existingCase as ItemDetail, {
        reporter: '', reporterVolume: null, firstPage: '',
        court: '', docketNumber: null, dateDecided: '',
      } as unknown as UpdateItemData);

      const clearedMeta = cleared.updateData.metadata as Record<string, unknown>;
      expect(cleared.updateData.publicationTitle).toBeNull();
      expect(cleared.updateData.year).toBeNull();
      expect(clearedMeta.publicationTitle).toBeNull();
      expect(clearedMeta.reporter).toBeNull();
      expect(clearedMeta.volume).toBeNull();
      expect(clearedMeta.pages).toBeNull();
      expect(clearedMeta.authority).toBeNull();
      expect(clearedMeta.issue).toBeNull();
      expect(clearedMeta.number).toBeNull();
      expect(clearedMeta.date).toBeNull();
      expect(clearedMeta.publicationDate).toBeNull();
    });

    it('SD3-03: syncs metadata.editors from creators/contributors when data.editors is undefined and clears stale editors when removed', () => {
      const existingBook: Record<string, unknown> = {
        id: 'book-1',
        itemType: 'book',
        title: 'Edited Volume',
        metadata: {
          editors: ['Old Editor'],
        },
      };

      const withNewEditor = buildCommandUpdateInput(userId, existingBook, {
        creators: [
          { firstName: 'Jane', lastName: 'Doe', creatorType: 'author' },
          { firstName: 'Grace', lastName: 'Hopper', creatorType: 'editor' },
        ],
      });
      const metaWithEditor = withNewEditor.updateData.metadata as Record<string, unknown>;
      expect(metaWithEditor.editors).toEqual(['Grace Hopper']);

      const withRemovedEditor = buildCommandUpdateInput(userId, existingBook, {
        creators: [{ firstName: 'Jane', lastName: 'Doe', creatorType: 'author' }],
      });
      const metaWithoutEditor = withRemovedEditor.updateData.metadata as Record<string, unknown>;
      expect(metaWithoutEditor.editors).toBeNull();
    });
  });

  describe('SD3-09 & SD3-10: ItemTransformer Round-Trip Recovery & ItemTypeConversionService Tombstones', () => {
    const typesService = new TypesService();
    const transformer = new ItemTransformer(typesService);

    it('SD3-09: prefers user-edited Extra lines over stale __unmapped_* keys and strips recovered __unmapped_* keys and Extra lines', () => {
      // Simulate journalArticle -> webpage (volume dropped into Extra & __unmapped_journalArticle_volume)
      // Then user edits "Volume: 99" in Extra before converting webpage -> journalArticle
      const webpageItem = {
        id: 'item-rt-1',
        itemType: 'webpage',
        title: 'Web Article',
        extra: 'Volume: 99\nIssue: 4\nCustom Note: Keep me',
        extraFields: {
          __unmapped_journalArticle_volume: '25',
          __unmapped_journalArticle_issue: '2',
        },
        metadata: {
          __unmapped_journalArticle_volume: '25',
          __unmapped_journalArticle_issue: '2',
        },
      };

      const preview = transformer.previewConversion(webpageItem, 'journalArticle');
      expect(preview.projectedItem.volume).toBe('99');
      expect(preview.projectedItem.issue).toBe('4');
      const projExtraFields = preview.projectedItem.extraFields as Record<string, unknown>;
      const projMeta = preview.projectedItem.metadata as Record<string, unknown>;
      expect(projExtraFields.__unmapped_journalArticle_volume).toBeUndefined();
      expect(projExtraFields.__unmapped_journalArticle_issue).toBeUndefined();
      expect(projMeta.__unmapped_journalArticle_volume).toBeUndefined();
      expect(projMeta.__unmapped_journalArticle_issue).toBeUndefined();
      expect(preview.projectedItem.extra).toBe('Custom Note: Keep me');
    });

    it('SD3-10: sets null tombstones in updatePayload.extraFields for droppedFields, remapped fromField keys, cleared shortTitle, and __unmapped_* keys when retainUnmappedInExtra is false', async () => {
      const existingBook: ItemDetail = {
        id: 'book-conv-1',
        userId,
        title: 'Distributed Systems Principles',
        shortTitle: 'DSP',
        itemType: 'book',
        publisher: 'MIT Press',
        edition: '2nd',
        isbn: '978-0-262-03384-8',
        version: 1,
        extraFields: {
          edition: '2nd',
          shortTitle: 'DSP',
          seriesNumber: '12',
          __unmapped_report_reportNumber: 'TR-99',
        },
        metadata: {
          edition: '2nd',
          shortTitle: 'DSP',
          seriesNumber: '12',
          publisher: 'MIT Press',
          __unmapped_report_reportNumber: 'TR-99',
        },
        creators: [{ firstName: 'Nancy', lastName: 'Lynch', creatorType: 'author' }],
      } as unknown as ItemDetail;

      const preview = transformer.previewConversion(existingBook, 'bookSection', {
        retainUnmappedInExtra: false,
      });
      const targetFields = typesService.getOrderedFields('bookSection');
      const updatePayload = buildTypeConversionUpdatePayload(
        'bookSection',
        existingBook,
        preview,
        targetFields,
        transformer,
        { retainUnmappedInExtra: false },
      );

      const extraFieldsPatch = updatePayload.extraFields as Record<string, unknown>;
      // shortTitle was cleared by book -> bookSection rule
      expect(extraFieldsPatch.shortTitle).toBeNull();
      // __unmapped_* keys tombstoned when retainUnmappedInExtra === false
      expect(extraFieldsPatch.__unmapped_report_reportNumber).toBeNull();

      // Also test converting bookSection -> patent where bookTitle, edition, seriesNumber are dropped/remapped
      const sectionItem: ItemDetail = {
        id: 'sec-conv-1',
        userId,
        title: 'Chapter 1',
        shortTitle: 'Ch1',
        itemType: 'bookSection',
        bookTitle: 'Parent Book',
        publisher: 'ACM',
        edition: '3rd',
        seriesNumber: '5',
        version: 2,
        extraFields: {
          bookTitle: 'Parent Book',
          edition: '3rd',
          seriesNumber: '5',
        },
        metadata: {
          bookTitle: 'Parent Book',
          edition: '3rd',
          seriesNumber: '5',
          publisher: 'ACM',
        },
        creators: [{ firstName: 'Alan', lastName: 'Kay', creatorType: 'author' }],
      } as unknown as ItemDetail;

      const patentPreview = transformer.previewConversion(sectionItem, 'patent', {
        retainUnmappedInExtra: false,
      });
      const patentFields = typesService.getOrderedFields('patent');
      const patentPayload = buildTypeConversionUpdatePayload(
        'patent',
        sectionItem,
        patentPreview,
        patentFields,
        transformer,
        { retainUnmappedInExtra: false },
      );

      const patentExtraFields = patentPayload.extraFields as Record<string, unknown>;
      // Dropped fields (edition, seriesNumber, bookTitle) and remapped fromField (publisher -> issuingAuthority) have null tombstones in extraFields
      expect(patentExtraFields.edition).toBeNull();
      expect(patentExtraFields.seriesNumber).toBeNull();
      expect(patentExtraFields.bookTitle).toBeNull();
      expect(patentExtraFields.publisher).toBeNull();
      expect(patentExtraFields.issuingAuthority).toBe('ACM');

      // Verify buildMetadataPartial deletes all null tombstoned fields from PostgreSQL Item.metadata
      const canonical = resolveCanonicalCommandFields(patentPayload as UpdateItemData, 'patent', {});
      const ids = normalizeItemIdentifiers(patentPayload as UpdateItemData, { preserveOnInvalid: true });
      const mergedMeta = buildMetadataPartial({
        mode: 'update',
        baseMeta: sectionItem.metadata as Record<string, unknown>,
        data: patentPayload as UpdateItemData,
        canonical,
        ids,
      });
      expect(mergedMeta.edition).toBeUndefined();
      expect(mergedMeta.seriesNumber).toBeUndefined();
      expect(mergedMeta.bookTitle).toBeUndefined();
      expect(mergedMeta.issuingAuthority).toBe('ACM');

      // Also test ItemTypeConversionService.convertItemType end-to-end
      const mockQuery = {
        findById: jest.fn().mockResolvedValue(sectionItem),
      };
      const mockCommand = {
        update: jest.fn().mockImplementation(async (_u: string, _id: string, _v: unknown, payload: Record<string, unknown>) => ({
          ...sectionItem,
          ...payload,
          version: 3,
        })),
      };
      const conversionService = new ItemTypeConversionService(
        mockQuery as never,
        mockCommand as never,
        typesService,
        transformer,
      );
      const converted = await conversionService.convertItemType(userId, 'sec-conv-1', 'patent', {
        retainUnmappedInExtra: false,
      });
      expect(converted.success).toBe(true);
      expect(mockCommand.update).toHaveBeenCalledWith(
        userId,
        'sec-conv-1',
        undefined,
        expect.objectContaining({
          extraFields: expect.objectContaining({
            edition: null,
            seriesNumber: null,
            bookTitle: null,
          }),
        }),
        undefined,
        undefined,
      );
    });
  });
});
