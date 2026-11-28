import { UnprocessableEntityException } from '@nestjs/common';
import { fromPartial } from '@total-typescript/shoehorn';
import { ItemService } from '@/modules/library/catalog/services/items.service';
import { ItemRelationsService } from '@/modules/library/catalog/services/relations.service';
import { ItemCurationService } from '@/modules/library/catalog/services/curation.service';
import { CatalogFacade } from '@/modules/library/catalog/services/catalog.facade';
import { TypesService } from '@/modules/library/catalog/services/types.service';
import { SchemaValidatorService } from '@/modules/library/catalog/services/schema-validator.service';
import { ItemTransformer } from '@/modules/library/catalog/services/item-transformer.service';
import { QueryRepository } from '@/modules/library/catalog/repositories/query.repository';
import {
  CommandRepository,
  resolveExtraPlainText,
  extractNonColumnExtraFields,
} from '@/modules/library/catalog/repositories/command.repository';
import { TagsService } from '@/modules/library/catalog/services/tags.service';
import {
  cleanSingleIdentifier,
  normalizeItemIdentifiers,
  syncMetadataIdentifierAliases,
} from '@/modules/library/catalog/domain/identifier-change.domain';
import {
  resolveCanonicalCommandFields,
  buildMetadataPartial,
  buildCommandCreateInput,
  buildCommandUpdateInput,
} from '@/modules/library/catalog/domain/item-command.mapper';
import { buildImportItemPayload } from '@/modules/library/catalog/domain/creator-tag.mapper';
import { LibraryFacade } from '@/modules/library/library.module';
import { TransactionService } from '@/modules/library/sync';
import { RedisCacheService } from '@/core';
import {
  ItemsMapper,
  LIBRARY_EVENT_TYPES,
  LIBRARY_REDIS_KEYS,
  VersionMismatchException,
  normalizeDoi,
} from '@/modules/library/core';

describe('Library Items — CRUD, OCC, Relations, Schema & Mappers', () => {
  const mockUserId = '11111111-1111-4111-8111-111111111111';
  const mockItemId = '22222222-2222-4222-8222-222222222222';
  const mockProjectId = '33333333-3333-4333-8333-333333333333';

  describe('ItemService & Cache Invalidation', () => {
    let service: ItemService;
    let relationsService: ItemRelationsService;
    let queryRepo: jest.Mocked<QueryRepository>;
    let commandRepo: jest.Mocked<CommandRepository>;
    let txService: jest.Mocked<TransactionService>;
    let tagsService: jest.Mocked<TagsService>;
    let cache: jest.Mocked<RedisCacheService>;

    const baseDbItem = {
      id: mockItemId,
      userId: mockUserId,
      title: 'Attention Is All You Need',
      itemType: 'journalArticle',
      version: 1,
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      contributors: [],
      collectionItems: [],
      itemTags: [],
      notes: [],
      attachments: [],
    };

    beforeEach(() => {
      queryRepo = fromPartial({
        findById: jest.fn().mockResolvedValue(baseDbItem),
        findMany: jest.fn().mockResolvedValue([baseDbItem]),
        count: jest.fn().mockResolvedValue(1),
        getRelations: jest.fn().mockResolvedValue([]),
      });

      commandRepo = fromPartial({
        create: jest.fn().mockResolvedValue(baseDbItem),
        update: jest.fn().mockResolvedValue({
          ...baseDbItem,
          version: 2,
          title: 'Updated Title',
        }),
        softDelete: jest.fn().mockResolvedValue(true),
        restore: jest.fn().mockResolvedValue({ ...baseDbItem, version: 3 }),
        purge: jest.fn().mockResolvedValue(true),
        putRelation: jest.fn().mockResolvedValue(undefined),
        removeRelation: jest.fn().mockResolvedValue(undefined),
      });

      txService = fromPartial({
        executeInTransaction: jest
          .fn()
          .mockImplementation(
            async (cb: (tx: unknown, h: Record<string, unknown>) => unknown) => {
              const helpers = {
                appendChange: jest.fn().mockResolvedValue(1n),
                publishOutbox: jest.fn().mockResolvedValue(undefined),
                recordTombstone: jest.fn().mockResolvedValue(undefined),
                removeTombstone: jest.fn().mockResolvedValue(1),
                removeTombstonesBatch: jest.fn().mockResolvedValue(1),
                appendChangesBatch: jest.fn().mockResolvedValue(1),
                recordTombstonesBatch: jest.fn().mockResolvedValue(1),
                publishOutboxBatch: jest.fn().mockResolvedValue([]),
              };
              return cb(fromPartial({}), helpers);
            },
          ),
      });

      tagsService = fromPartial({
        invalidateTagsCache: jest.fn().mockResolvedValue(undefined),
      });

      cache = fromPartial({
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue(undefined),
        del: jest.fn().mockResolvedValue(undefined),
        delPattern: jest.fn().mockResolvedValue(undefined),
      });

      const validator = fromPartial<SchemaValidatorService>({
        validateAndSanitizeItem: jest.fn((_type, d) => ({
          valid: true,
          sanitizedItem: d,
          warnings: [],
          demotedToExtra: {},
        })),
      });

      relationsService = new ItemRelationsService(queryRepo, commandRepo);
      service = new ItemService(
        queryRepo,
        commandRepo,
        txService,
        tagsService,
        validator,
        cache,
      );
    });

    it('rejects creating or updating items with empty or script-only titles', async () => {
      await expect(
        service.createItem(mockUserId, {
          title: '   ',
          itemType: 'journalArticle',
          uploadedById: mockUserId,
        }),
      ).rejects.toThrow(UnprocessableEntityException);

      await expect(
        service.createItem(mockUserId, {
          title: '<script>alert(1)</script>',
          itemType: 'journalArticle',
          uploadedById: mockUserId,
        }),
      ).rejects.toThrow(UnprocessableEntityException);

      await expect(
        service.updateItem(mockUserId, mockItemId, 1, { title: '   ' }),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('sanitizes titles and invalidates caches across create, update, delete, restore, and purge', async () => {
      await service.createItem(mockUserId, {
        title: '<script>evil()</script>Attention Is All You Need',
        itemType: 'journalArticle',
        doi: '10.1145/3065386',
        uploadedById: mockUserId,
      });
      expect(commandRepo.create).toHaveBeenCalledWith(
        mockUserId,
        expect.objectContaining({ title: 'Attention Is All You Need' }),
        expect.anything(),
        undefined,
      );
      expect(cache.delPattern).toHaveBeenCalledWith(
        LIBRARY_REDIS_KEYS.itemsPattern(mockUserId),
      );

      cache.del.mockClear();
      cache.delPattern.mockClear();

      await service.updateItem(mockUserId, mockItemId, 1, {
        title: ' <b>Clean</b> Updated {Title} ',
      });
      expect(commandRepo.update).toHaveBeenCalledWith(
        mockUserId,
        mockItemId,
        1,
        expect.objectContaining({ title: 'Clean Updated Title' }),
        expect.anything(),
        undefined,
      );
      expect(cache.del).toHaveBeenCalledWith(LIBRARY_REDIS_KEYS.item(mockItemId));
      expect(cache.del).toHaveBeenCalledWith(
        LIBRARY_REDIS_KEYS.itemFulltext(mockItemId),
      );
      expect(cache.delPattern).toHaveBeenCalledWith(
        LIBRARY_REDIS_KEYS.itemsPattern(mockUserId),
      );

      cache.del.mockClear();
      await service.deleteItem(mockUserId, mockItemId, 1);
      expect(cache.del).toHaveBeenCalledWith(LIBRARY_REDIS_KEYS.item(mockItemId));

      cache.del.mockClear();
      await service.restoreItem(mockUserId, mockItemId, 2);
      expect(cache.del).toHaveBeenCalledWith(LIBRARY_REDIS_KEYS.item(mockItemId));

      cache.del.mockClear();
      await service.purgeItem(mockUserId, mockItemId);
      expect(cache.del).toHaveBeenCalledWith(LIBRARY_REDIS_KEYS.item(mockItemId));
    });

    it('records CDC + Outbox events and invalidates project list cache on LibraryFacade.updateItemAiMetadata', async () => {
      const itemMock = {
        findUnique: jest.fn().mockResolvedValue({
          id: mockItemId,
          userId: mockUserId,
          projectId: mockProjectId,
          metadata: { existingKey: 'val' },
        }),
        update: jest.fn().mockResolvedValue({
          id: mockItemId,
          userId: mockUserId,
          projectId: mockProjectId,
          version: 2,
          metadata: { aiSummary: 'Summary' },
        }),
      };
      const mockPrisma = { item: itemMock, libraryItem: itemMock };
      const mockAppendChange = jest.fn().mockResolvedValue({});
      const mockPublishOutbox = jest.fn().mockResolvedValue({});
      const mockUow = {
        executeInTransaction: jest.fn(
          async (
            op: (
              tx: unknown,
              helpers: { appendChange: jest.Mock; publishOutbox: jest.Mock },
            ) => Promise<unknown>,
          ) =>
            op(mockPrisma, {
              appendChange: mockAppendChange,
              publishOutbox: mockPublishOutbox,
            }),
        ),
      };

      const curationService = new ItemCurationService(
        new QueryRepository(mockPrisma as never),
        new CommandRepository(mockPrisma as never),
        mockUow as never,
        cache,
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

      await facade.updateItemAiMetadata(mockItemId, { aiSummary: 'Summary' });

      expect(mockAppendChange).toHaveBeenCalledWith(
        { userId: mockUserId, projectId: mockProjectId },
        expect.objectContaining({
          entityType: 'Item',
          entityId: mockItemId,
          action: 'update',
          version: 2,
        }),
      );
      expect(mockPublishOutbox).toHaveBeenCalledWith(
        { userId: mockUserId, projectId: mockProjectId },
        mockItemId,
        LIBRARY_EVENT_TYPES.ITEM_UPDATED,
        expect.objectContaining({ id: mockItemId, version: 2 }),
      );
      expect(cache.delPattern).toHaveBeenCalledWith(
        LIBRARY_REDIS_KEYS.itemsPattern(`proj:${mockProjectId}`),
      );
    });

    describe('ItemRelationsService', () => {
      const sourceId = '44444444-4444-4444-8444-444444444444';
      const targetId1 = '55555555-5555-4555-8555-555555555555';
      const targetId2 = '66666666-6666-4666-8666-666666666666';

      it('retrieves, links (single & batch), unlinks, and blocks self-linking', async () => {
        queryRepo.findById.mockResolvedValueOnce(
          fromPartial({ id: sourceId, title: 'Source Paper' }),
        );
        queryRepo.getRelations.mockResolvedValueOnce([
          fromPartial({
            id: targetId1,
            title: 'Related Paper 1',
            relationType: 'related',
          }),
        ]);

        const related = await relationsService.getRelatedItems(
          mockUserId,
          sourceId,
        );
        expect(related.total).toBe(1);
        expect(related.relatedItems[0].title).toBe('Related Paper 1');

        queryRepo.findById
          .mockResolvedValueOnce(fromPartial({ id: sourceId }))
          .mockResolvedValueOnce(fromPartial({ id: targetId1 }))
          .mockResolvedValueOnce(fromPartial({ id: targetId2 }));

        const linked = await relationsService.linkItems(mockUserId, sourceId, {
          targetItemIds: [targetId1, targetId2],
          relationType: 'cites',
        });
        expect(linked.totalLinked).toBe(2);

        queryRepo.findById.mockResolvedValueOnce(fromPartial({ id: sourceId }));
        await expect(
          relationsService.linkItems(mockUserId, sourceId, {
            targetItemId: sourceId,
          }),
        ).rejects.toThrow();

        queryRepo.findById.mockResolvedValueOnce(fromPartial({ id: sourceId }));
        const unlinked = await relationsService.unlinkItems(
          mockUserId,
          sourceId,
          targetId1,
        );
        expect(unlinked.unlinked).toBe(true);
      });
    });
  });

  describe('CommandRepository Optimistic Concurrency Control (OCC)', () => {
    let repo: CommandRepository;
    let itemMock: {
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      updateMany: jest.Mock;
      update: jest.Mock;
      findMany: jest.Mock;
    };

    beforeEach(() => {
      itemMock = {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        updateMany: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      };
      const fileMock = { updateMany: jest.fn() };
      const mockPrisma = {
        item: itemMock,
        libraryItem: itemMock,
        file: fileMock,
        fileNode: fileMock,
        itemIdentifier: {
          deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
          upsert: jest.fn().mockResolvedValue({}),
        },
      };
      repo = new CommandRepository(mockPrisma as never);
    });

    it('atomically reserves version via updateMany and increments version to 2', async () => {
      itemMock.findFirst.mockResolvedValue({
        id: mockItemId,
        userId: mockUserId,
        version: 1,
        title: 'Original Title',
        metadata: {},
        contributors: [],
        identifiers: [],
      });
      itemMock.updateMany.mockResolvedValue({ count: 1 });
      itemMock.update.mockResolvedValue({
        id: mockItemId,
        userId: mockUserId,
        version: 2,
        title: 'Updated Title',
      });

      const result = await repo.update(mockUserId, mockItemId, 1, {
        title: 'Updated Title',
      });
      expect(result.version).toBe(2);
      expect(itemMock.updateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          id: mockItemId,
          version: 1,
          deletedAt: null,
          spaceId: mockUserId,
        }),
        data: { version: { increment: 1 } },
      });
    });

    it('throws VersionMismatchException on stale version or concurrent race (updateMany count=0)', async () => {
      itemMock.findFirst.mockResolvedValueOnce({
        id: mockItemId,
        userId: mockUserId,
        version: 3,
        title: 'Already updated',
      });
      await expect(
        repo.update(mockUserId, mockItemId, 1, { title: 'Stale' }),
      ).rejects.toThrow(VersionMismatchException);

      itemMock.findFirst.mockResolvedValueOnce({
        id: mockItemId,
        userId: mockUserId,
        version: 1,
        title: 'Initial',
      });
      itemMock.updateMany.mockResolvedValueOnce({ count: 0 });
      itemMock.findUnique.mockResolvedValueOnce({ id: mockItemId, version: 2 });

      await expect(
        repo.update(mockUserId, mockItemId, 1, { title: 'Race conflict' }),
      ).rejects.toThrow(VersionMismatchException);
    });

    it('enforces expectedVersion guard on softDelete', async () => {
      itemMock.updateMany.mockResolvedValueOnce({ count: 1 });
      expect(await repo.softDelete(mockUserId, mockItemId, 1)).toBe(true);

      itemMock.updateMany.mockResolvedValueOnce({ count: 0 });
      itemMock.findFirst.mockResolvedValueOnce({ id: mockItemId, version: 2 });
      await expect(repo.softDelete(mockUserId, mockItemId, 1)).rejects.toThrow(
        VersionMismatchException,
      );
    });
  });

  describe('Zotero Schema v42 Validation, Conversion & Command Mappers', () => {
    const typesService = new TypesService();
    const validator = new SchemaValidatorService(typesService);
    const transformer = new ItemTransformer(typesService);

    it('registers all 37 bibliographic types and validates type-specific fields', () => {
      const snapshot = typesService.getSnapshot();
      expect(snapshot.version).toBe(42);
      const bibTypes = Object.values(snapshot.itemTypes).filter(
        (t) => t.isBibliographic,
      );
      expect(bibTypes).toHaveLength(37);
      expect(typesService.isValidFieldForType('journalArticle', 'volume')).toBe(
        true,
      );
      expect(
        typesService.isValidFieldForType('journalArticle', 'patentNumber'),
      ).toBe(false);
      expect(typesService.isValidFieldForType('patent', 'patentNumber')).toBe(
        true,
      );
    });

    it('preserves partial updates without injecting empty creators, demotes unknown fields to extra, and harmonizes creator roles', () => {
      const partial = validator.validateAndSanitizeItem('journalArticle', {
        volume: '15',
        pages: '100-110',
      });
      expect(partial.sanitizedItem.creators).toBeUndefined();

      const withCustom = validator.validateAndSanitizeItem('patent', {
        patentNumber: 'US1234567',
        unknownCustomField: 'SpecialValue',
      });
      expect(withCustom.sanitizedItem.extra).toContain(
        'unknownCustomField: SpecialValue',
      );
      expect(withCustom.demotedToExtra.unknownCustomField).toBe('SpecialValue');

      const patentCreators = validator.validateAndHarmonizeCreators('patent', [
        { firstName: 'Nikola', lastName: 'Tesla', creatorType: 'author' },
        { firstName: 'Thomas', lastName: 'Edison', creatorType: 'co_author' },
      ]);
      expect(patentCreators.creators.map((c) => c.creatorType)).toEqual([
        'inventor',
        'inventor',
      ]);

      const bookSectionCreators = validator.validateAndHarmonizeCreators(
        'bookSection',
        [
          { firstName: 'Jane', lastName: 'Doe', creatorType: 'book_author' },
          { firstName: 'John', lastName: 'Smith', creatorType: 'advisor' },
        ],
      );
      expect(bookSectionCreators.creators.map((c) => c.creatorType)).toEqual([
        'bookAuthor',
        'contributor',
      ]);
    });

    it('converts item types (preprint -> journalArticle -> bookSection -> patent) preserving unmapped fields in extra', () => {
      const preprintToArticle = transformer.previewConversion(
        {
          itemType: 'preprint',
          title: 'Attention Is All You Need',
          arxivId: '1706.03762',
          date: '2017-06-12',
        },
        'journalArticle',
      );
      expect(preprintToArticle.targetType).toBe('journalArticle');
      expect(String(preprintToArticle.projectedItem.extra)).toContain('arXiv');

      const articleToBookSection = transformer.previewConversion(
        {
          itemType: 'journalArticle',
          title: 'The Representation of Knowledge',
          publicationTitle: 'Handbook of Cognitive Science',
          issue: '4',
        },
        'bookSection',
      );
      expect(articleToBookSection.projectedItem.bookTitle).toBe(
        'Handbook of Cognitive Science',
      );
      expect(String(articleToBookSection.projectedItem.extra)).toContain(
        'Issue: 4',
      );

      const articleToPatent = transformer.previewConversion(
        {
          itemType: 'journalArticle',
          title: 'Quantum Neural Networks',
          volume: '42',
          issue: '3',
          pages: '123-130',
        },
        'patent',
        { retainUnmappedInExtra: true },
      );
      const projected = articleToPatent.projectedItem as Record<
        string,
        unknown
      >;
      expect(projected.volume).toBeUndefined();
      expect(projected.pages).toBe('123-130');
      expect(String(projected.extra)).toContain('Volume: 42');
      expect(
        (projected.extraFields as Record<string, unknown>)
          .__unmapped_journalArticle_volume,
      ).toBe('42');
    });

    it('maps domain items, extra plain-text fields, identifier clearing, and command payloads accurately', () => {
      const mappedBook: Record<string, unknown> = ItemsMapper.toDomain({
        itemType: 'book',
        title: 'Clean Code',
        extra: 'Edition: 2nd\nnumPages: 464\nConference Name: ACM SIGMOD',
      }) as unknown as Record<string, unknown>;
      expect(mappedBook.edition).toBe('2nd');
      expect(mappedBook.numPages).toBe(464);

      const mappedArticle: Record<string, unknown> = ItemsMapper.toDomain({
        id: '018f3a21-1234-7000-8000-000000000005',
        itemType: 'journalArticle',
        doi: '10.1234/test',
        arxivId: '2301.00001',
        publicationDate: '2023-01-01',
        journalAbbr: 'Nat. Mach. Intell.',
        attachments: [
          {
            id: 'att-1',
            filename: 'raw_file.pdf',
            fileId: '018f3a21-1234-7000-8000-000000000006',
            attachmentType: 'primary_pdf',
            metadata: { title: 'Author Manuscript PDF' },
          },
        ],
      } as never) as unknown as Record<string, unknown>;
      expect(mappedArticle.DOI).toBe('10.1234/test');
      expect(mappedArticle.archiveId).toBe('2301.00001');
      expect(mappedArticle.journalAbbreviation).toBe('Nat. Mach. Intell.');
      expect(
        (mappedArticle.primaryFile as { title?: string } | undefined)?.title,
      ).toBe('Author Manuscript PDF');

      const extraObj = extractNonColumnExtraFields({
        title: 'Paper Title',
        edition: '3rd',
        eventPlace: 'Vienna, Austria',
      });
      expect(extraObj).toEqual({
        edition: '3rd',
        eventPlace: 'Vienna, Austria',
      });
      expect(
        resolveExtraPlainText(undefined, 'Edition: 1st\nLocation: Boston', {
          edition: '2nd',
        }),
      ).toBe('Edition: 2nd\nLocation: Boston');
      expect(
        resolveExtraPlainText(undefined, 'Edition: 1st\nLocation: Boston', {
          edition: null,
        }),
      ).toBe('Location: Boston');

      expect(cleanSingleIdentifier('not-a-valid-doi', normalizeDoi)).toBe('');
      const clearedIds = normalizeItemIdentifiers({
        doi: '',
        isbn: null,
        extraFields: { doi: '10.1000/stale', isbn: '978-0-262-03384-8' },
        extra: 'DOI: 10.1000/stale\nISBN: 978-0-262-03384-8\nCustom: Value',
      });
      const meta: Record<string, unknown> = {
        doi: '10.1000/stale',
        DOI: '10.1000/stale',
        isbn: '978-0-262-03384-8',
        extra: 'DOI: 10.1000/stale\nISBN: 978-0-262-03384-8\nCustom: Value',
      };
      syncMetadataIdentifierAliases(meta, clearedIds, { isCreate: false });
      expect(meta.doi).toBeNull();
      expect(meta.DOI).toBeUndefined();
      expect(meta.extra).toBe('Custom: Value');

      const updateData = {
        itemType: 'bookSection',
        bookTitle: 'Updated Handbook of AI',
        publicationTitle: 'Stale Book Title',
        metadata: { publicationTitle: 'Stale Book Title', volume: '1' },
        volume: '2',
      };
      const canonical = resolveCanonicalCommandFields(
        updateData,
        'bookSection',
      );
      const builtMeta = buildMetadataPartial({
        mode: 'update',
        baseMeta: { publicationTitle: 'Stale Book Title', volume: '1' },
        data: updateData,
        canonical,
        ids: normalizeItemIdentifiers(updateData as never),
      });
      expect(builtMeta.bookTitle).toBe('Updated Handbook of AI');
      expect(builtMeta.volume).toBe('2');

      const createInput = buildCommandCreateInput(mockUserId, {
        title: 'Collaborative Project Paper',
        itemType: 'journalArticle',
        doi: '10.1038/s41586-021-03819-2',
        projectId: mockProjectId,
      });
      expect(createInput.createData.spaceId).toBe(mockProjectId);
      expect(createInput.createData.createdById).toBe(mockUserId);

      const updateInput = buildCommandUpdateInput(
        mockUserId,
        { id: 'item-1', title: 'Old', itemType: 'journalArticle', year: 2023 },
        { title: 'Updated Collaborative Paper Title', isRetracted: true },
      );
      expect(updateInput.updateData.title).toBe(
        'Updated Collaborative Paper Title',
      );
      expect(updateInput.updateData.isRetracted).toBe(true);

      const importPayload = buildImportItemPayload(
        {
          title: 'Imported Paper',
          itemType: 'conferencePaper',
          year: 2024,
          contributors: [
            { firstName: 'Yann', lastName: 'LeCun', creatorType: 'author' },
          ],
          itemTags: [{ tag: { name: 'Self-Supervised Learning' } }],
        },
        mockUserId,
      );
      expect(importPayload.creators?.[0].lastName).toBe('LeCun');
      expect(importPayload.tags).toEqual(['Self-Supervised Learning']);
    });

    it('strips junk tags in ItemsMapper.mapFlattenedState without reviving raw fallback strings', () => {
      const mapped: unknown = ItemsMapper.mapFlattenedState(
        {
          id: '123e4567-e89b-12d3-a456-426614174000',
          title: 'Test Paper',
          itemTags: [
            { tag: { name: 'Deep Learning', type: 'manual' } },
            { tag: { name: 'n/a', type: 'automatic' } },
            { tag: { name: 'doi: 10.1038/xyz', type: 'automatic' } },
            { tag: { name: 'COVID-19', type: 'manual' } },
          ],
        } as never,
        mockUserId,
      );
      expect((mapped as { tags?: string[] }).tags).toEqual([
        'Deep Learning',
        'COVID-19',
      ]);
    });
  });
});
