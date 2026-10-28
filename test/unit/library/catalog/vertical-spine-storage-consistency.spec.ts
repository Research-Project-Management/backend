import {
  resolveCanonicalCommandFields,
  buildMetadataPartial,
  buildCommandUpdateInput,
  syncMetadataIdentifierAliases,
  normalizeItemIdentifiers,
  prepareContributorsToCreate,
  deriveFirstAuthor,
} from '@/modules/library/catalog/domain/command-payload.builder';
import { ItemsMapper } from '@/modules/library/catalog/domain/items.mapper';
import { ItemTransformer } from '@/modules/library/catalog/domain/item.transformer';
import { TypesService } from '@/modules/library/catalog/services/types.service';
import {
  ItemTypeConversionService,
  buildTypeConversionUpdatePayload,
} from '@/modules/library/catalog/services/item-type-conversion.service';
import { ItemService } from '@/modules/library/catalog/services/items.service';
import { CommandRepository } from '@/modules/library/catalog/repositories/command.repository';
import { setMyPublicationInClient } from '@/modules/library/catalog/repositories/command-relations.helper';
import { ItemProvenancePolicy } from '@/modules/library/core/domain/item-provenance.domain';
import { ZoteroSchemaValidatorService } from '@/modules/library/catalog/services/zotero-schema-validator.service';
import { LIBRARY_EVENT_TYPES } from '@/modules/library/core';

describe('Vertical Spine, Triple-Storage & Type Conversion Consistency', () => {
  const typesService = new TypesService();
  const transformer = new ItemTransformer(typesService);
  const validator = new ZoteroSchemaValidatorService(typesService);

  describe('1. Prevent Resurrection of Cleared/Updated Fields on Read', () => {
    it('clears baseField and mappedField in metadata when base or mapped fields are cleared', () => {
      const existing = {
        id: '11111111-1111-4111-8111-111111111111',
        itemType: 'thesis',
        title: 'Quantum Computing Thesis',
        year: 2021,
        metadata: {
          publisher: 'MIT',
          university: 'MIT',
          place: 'Cambridge, MA',
          volume: '1',
          issue: 'TR-42',
          number: 'TR-42',
          pages: '1-150',
          date: '2021-05-01',
          publicationDate: '2021-05-01',
        },
      };

      const { updateData } = buildCommandUpdateInput('user-1', existing, {
        university: null,
        place: '',
        volume: null,
        issue: null,
        pages: '',
        date: null,
      });

      const meta = updateData.metadata as Record<string, unknown>;
      expect(meta.publisher).toBeNull();
      expect(meta.university).toBeUndefined();
      expect(meta.place).toBeNull();
      expect(meta.volume).toBeNull();
      expect(meta.issue).toBeNull();
      expect(meta.number).toBeUndefined();
      expect(meta.pages).toBeNull();
      expect(meta.date).toBeNull();
      expect(meta.publicationDate).toBeNull();

      const domainItem = ItemsMapper.toDomain({
        ...existing,
        ...updateData,
        year: updateData.year,
        metadata: meta,
      });
      expect(domainItem.university).toBe('');
      expect(domainItem.publisher).toBe('');
      expect(domainItem.place).toBe('');
      expect(domainItem.volume).toBe('');
      expect(domainItem.issue).toBe('');
      expect(domainItem.pages).toBe('');
      expect(domainItem.date).toBe('');
    });

    it('clears journal/venue when publicationTitle is updated on non-journalArticle, or syncs journal on journalArticle, and clears all container aliases when cleared', () => {
      const existingConf = {
        id: '11111111-1111-4111-8111-111111111111',
        itemType: 'conferencePaper',
        title: 'Paper',
        metadata: {
          publicationTitle: 'Old Conf',
          proceedingsTitle: 'Old Conf',
          journal: 'Stale Journal',
          venue: 'Stale Venue',
        },
      };

      const { updateData: confUpdate } = buildCommandUpdateInput('user-1', existingConf, {
        proceedingsTitle: 'NeurIPS 2025',
      });
      const confMeta = confUpdate.metadata as Record<string, unknown>;
      expect(confMeta.publicationTitle).toBe('NeurIPS 2025');
      expect(confMeta.proceedingsTitle).toBe('NeurIPS 2025');
      expect(confMeta.journal).toBeUndefined();
      expect(confMeta.venue).toBeUndefined();

      const existingJournal = {
        id: '11111111-1111-4111-8111-111111111112',
        itemType: 'journalArticle',
        title: 'Article',
        metadata: {
          publicationTitle: 'Old Journal',
          journal: 'Old Journal',
          venue: 'Old Venue',
        },
      };
      const { updateData: journalUpdate } = buildCommandUpdateInput('user-1', existingJournal, {
        publicationTitle: 'Nature',
      });
      const journalMeta = journalUpdate.metadata as Record<string, unknown>;
      expect(journalMeta.publicationTitle).toBe('Nature');
      expect(journalMeta.journal).toBe('Nature');
      expect(journalMeta.venue).toBeUndefined();

      const { updateData: clearedUpdate } = buildCommandUpdateInput('user-1', {
        ...existingJournal,
        metadata: {
          ...journalMeta,
          reporter: 'U.S.',
          code: 'USC',
          repository: 'arXiv',
          venue: 'Conf',
          sessionTitle: 'Session 1',
        },
      }, {
        publicationTitle: null,
      });
      const clearedMeta = clearedUpdate.metadata as Record<string, unknown>;
      expect(clearedMeta.publicationTitle).toBeNull();
      expect(clearedMeta.journal).toBeUndefined();
      expect(clearedMeta.reporter).toBeUndefined();
      expect(clearedMeta.code).toBeUndefined();
      expect(clearedMeta.repository).toBeUndefined();
      expect(clearedMeta.venue).toBeUndefined();
      expect(clearedMeta.sessionTitle).toBeUndefined();
    });

    it('deletes metadata.abstract when abstract is updated or cleared, and syncs url and citationKey without resurrection from extra', () => {
      const existing = {
        id: '11111111-1111-4111-8111-111111111113',
        itemType: 'journalArticle',
        title: 'Test',
        abstract: 'Old abstract',
        url: 'https://old.example.com',
        citationKey: 'old2020',
        metadata: {
          abstract: 'Old abstract',
          abstractNote: 'Old abstract',
          url: 'https://old.example.com',
          URL: 'https://old.example.com',
          citationKey: 'old2020',
          citeKey: 'old2020',
          extra: 'Citation Key: old2020\nPMID: 111111\narXiv: 2101.00001 {:arxiv: 2101.00001}',
        },
      };

      const { updateData } = buildCommandUpdateInput('user-1', existing, {
        abstract: 'New abstract text',
        url: null,
        citationKey: null,
        pmid: '999999',
        arxivId: '2501.99999',
      });

      const meta = updateData.metadata as Record<string, unknown>;
      expect(meta.abstract).toBeUndefined();
      expect(meta.abstractNote).toBe('New abstract text');
      expect(meta.url).toBeUndefined();
      expect(meta.URL).toBeUndefined();
      expect(meta.citationKey).toBeUndefined();
      expect(meta.citeKey).toBeUndefined();
      expect(meta.pmid).toBe('999999');
      expect(meta.arxivId).toBe('2501.99999');
      expect(String(meta.extra || '')).not.toMatch(/citation\s*key/i);
      expect(String(meta.extra || '')).not.toContain('111111');
      expect(String(meta.extra || '')).not.toContain('2101.00001');

      const domain = ItemsMapper.toDomain({
        ...existing,
        ...updateData,
        metadata: meta,
      });
      expect(domain.abstract).toBe('New abstract text');
      expect(domain.url).toBe('');
      expect(domain.citationKey).toBe('');
      expect(domain.pmid).toBe('999999');
      expect(domain.arxivId).toBe('2501.99999');
    });
  });

  describe('2. Fix ZoteroSchemaValidatorService type = itemType Shadowing baseMap.type', () => {
    it('preserves thesisType/reportType/websiteType when ZoteroSchemaValidatorService sets type = itemType', () => {
      const sanitized = validator.validateAndSanitizeItem('thesis', {
        title: 'Doctoral Dissertation',
        itemType: 'thesis',
        thesisType: 'PhD Thesis',
      }).sanitizedItem;

      expect(sanitized.type).toBe('thesis');
      const canonical = resolveCanonicalCommandFields(sanitized, 'thesis', {});
      expect(canonical.rawTypeField).toBe('PhD Thesis');

      const ids = normalizeItemIdentifiers(sanitized);
      const meta = buildMetadataPartial({
        mode: 'update',
        baseMeta: {},
        data: sanitized,
        canonical,
        ids,
      });
      expect(meta.type).toBe('PhD Thesis');
      expect(meta.thesisType).toBe('PhD Thesis');

      // Clearing thesisType
      const clearedSanitized = validator.validateAndSanitizeItem('thesis', {
        itemType: 'thesis',
        thesisType: null,
      }).sanitizedItem;
      const clearedCanonical = resolveCanonicalCommandFields(clearedSanitized, 'thesis', {});
      expect(clearedCanonical.rawTypeField).toBeNull();
      const clearedMeta = buildMetadataPartial({
        mode: 'update',
        baseMeta: meta,
        data: clearedSanitized,
        canonical: clearedCanonical,
        ids: normalizeItemIdentifiers(clearedSanitized),
      });
      expect(clearedMeta.type).toBeNull();
      expect(clearedMeta.thesisType).toBeUndefined();
    });
  });

  describe('3. Fix Item Type Conversion False Losses & Stale Base Columns', () => {
    it('does not report false dropped fields when converting conferencePaper -> journalArticle', () => {
      const confItem = {
        id: '11111111-1111-4111-8111-111111111114',
        itemType: 'conferencePaper',
        title: 'Attention Is All You Need',
        publicationTitle: 'Advances in Neural Information Processing Systems',
        proceedingsTitle: 'Advances in Neural Information Processing Systems',
        place: 'Long Beach, CA',
        eventPlace: 'Long Beach, CA',
        metadata: {
          publicationTitle: 'Advances in Neural Information Processing Systems',
          proceedingsTitle: 'Advances in Neural Information Processing Systems',
          place: 'Long Beach, CA',
          eventPlace: 'Long Beach, CA',
        },
      };

      const preview = transformer.previewConversion(confItem, 'journalArticle');
      expect(preview.droppedFields).toEqual([]);
      expect(preview.hasLoss).toBe(false);
      expect(preview.projectedItem.publicationTitle).toBe(
        'Advances in Neural Information Processing Systems',
      );
    });

    it('clears unmapped base columns and migrates base fields in buildTypeConversionUpdatePayload & buildCommandUpdateInput', () => {
      const bookItem = {
        id: '11111111-1111-4111-8111-111111111115',
        itemType: 'book',
        title: 'Deep Learning',
        shortTitle: 'DL Book',
        publisher: 'MIT Press',
        place: 'Cambridge',
        metadata: {
          shortTitle: 'DL Book',
          publisher: 'MIT Press',
          place: 'Cambridge',
        },
      };

      const preview = transformer.previewConversion(bookItem, 'bookSection');
      const targetFields = typesService.getOrderedFields('bookSection');
      const payload = buildTypeConversionUpdatePayload(
        'bookSection',
        bookItem as never,
        preview,
        targetFields,
        transformer,
      );

      expect(payload.shortTitle).toBeNull();
      expect(payload.bookTitle || (payload.extraFields as Record<string, unknown>)?.bookTitle).toBe('Deep Learning');

      const { updateData } = buildCommandUpdateInput('user-1', bookItem, payload);
      const updatedMeta = updateData.metadata as Record<string, unknown>;
      expect(updatedMeta.shortTitle).toBeNull();
      expect(updatedMeta.bookTitle).toBe('Deep Learning');
    });
  });

  describe('4. Fix Date / Year / PublicationDate Synchronization', () => {
    it('replaces 4-digit year in existing full ISO date when year is updated alone, and extracts year when date is updated', () => {
      const existing = {
        id: '11111111-1111-4111-8111-111111111116',
        itemType: 'patent',
        title: 'Neural Processor Patent',
        year: 2021,
        metadata: {
          date: '2021-03-10',
          publicationDate: '2021-03-10',
          issueDate: '2021-03-10',
        },
      };

      const { updateData: yearOnlyUpdate } = buildCommandUpdateInput('user-1', existing, {
        year: 2025,
      });
      const metaAfterYear = yearOnlyUpdate.metadata as Record<string, unknown>;
      expect(yearOnlyUpdate.year).toBe(2025);
      expect(metaAfterYear.date).toBe('2025-03-10');
      expect(metaAfterYear.publicationDate).toBe('2025-03-10');
      expect(metaAfterYear.issueDate).toBe('2025-03-10');

      // When issueDate is updated and data.year still equals existing.year, extractedYear wins
      const { updateData: dateUpdate } = buildCommandUpdateInput('user-1', existing, {
        issueDate: '2024-11-20',
        year: 2021,
      });
      expect(dateUpdate.year).toBe(2024);
      const metaAfterDate = dateUpdate.metadata as Record<string, unknown>;
      expect(metaAfterDate.date).toBe('2024-11-20');
      expect(metaAfterDate.publicationDate).toBe('2024-11-20');

      // Clearing year clears date, publicationDate, and mappedDateKey
      const { updateData: clearYearUpdate } = buildCommandUpdateInput('user-1', existing, {
        year: null,
      });
      const metaAfterClear = clearYearUpdate.metadata as Record<string, unknown>;
      expect(clearYearUpdate.year).toBeNull();
      expect(metaAfterClear.date).toBeNull();
      expect(metaAfterClear.publicationDate).toBeNull();
      expect(metaAfterClear.issueDate).toBeUndefined();
    });
  });

  describe('5. Provenance Transfer, Manual Locks, Soft-Deleted Attachment Filtering & Creator Primary Role', () => {
    it('transfers provenance and coupled aliases cleanly on item type conversion', () => {
      const existing = {
        metadata: {
          lockedFields: ['publicationTitle', 'journal', 'venue'],
          fieldProvenance: {
            publicationTitle: { source: 'UserOverride', isUserOverride: true, confidence: 1 },
            journal: { source: 'UserOverride', isUserOverride: true, confidence: 1 },
            venue: { source: 'UserOverride', isUserOverride: true, confidence: 1 },
          },
        },
      };

      const transferred = ItemProvenancePolicy.transferConversionProvenance(existing, {
        droppedFields: [],
        mappedFields: [
          {
            fromField: 'publicationTitle',
            toField: 'proceedingsTitle',
            value: 'ICML',
            rule: 'base-semantic',
          },
        ],
      });

      expect(transferred.lockedFields).toContain('proceedingsTitle');
      expect(transferred.lockedFields).not.toContain('publicationTitle');
      expect(transferred.lockedFields).not.toContain('journal');
      expect(transferred.fieldProvenance.proceedingsTitle).toBeDefined();
      expect(transferred.fieldProvenance.publicationTitle).toBeUndefined();
      expect(transferred.fieldProvenance.journal).toBeUndefined();
    });

    it('locks type-specific top-level fields via effectiveExtraFields on manual edit', () => {
      const existing = {
        id: '11111111-1111-4111-8111-111111111117',
        itemType: 'thesis',
        title: 'Thesis',
        metadata: {},
      };

      const { updateData } = buildCommandUpdateInput('user-1', existing, {
        university: 'Stanford University',
      });
      const meta = updateData.metadata as Record<string, unknown>;
      expect(meta.lockedFields).toContain('university');
    });

    it('uses primary creator role for itemType in prepareContributorsToCreate and deriveFirstAuthor', () => {
      const contributors = prepareContributorsToCreate(
        { authors: ['Ada Lovelace', 'Charles Babbage'] },
        'computerProgram',
      );
      expect(contributors).toHaveLength(2);
      expect(contributors![0].creatorType).toBe('programmer');
      expect(
        deriveFirstAuthor({
          contributors: contributors!,
          itemType: 'computerProgram',
        }),
      ).toBe('Lovelace et al.');
    });

    it('filters soft-deleted attachments in CommandRepository and includes updatedFields in ItemService.updateItem', async () => {
      const itemUpdateMock = jest.fn().mockResolvedValue({
        id: '11111111-1111-4111-8111-111111111118',
        userId: '22222222-2222-4222-8222-222222222222',
        title: 'Updated Title',
        itemType: 'journalArticle',
        version: 2,
        metadata: {},
      });
      const mockPrisma = {
        item: {
          findFirst: jest.fn().mockResolvedValue({
            id: '11111111-1111-4111-8111-111111111118',
            userId: '22222222-2222-4222-8222-222222222222',
            title: 'Old Title',
            itemType: 'journalArticle',
            version: 1,
             deletedAt: new Date(),
            metadata: {},
          }),
          update: itemUpdateMock,
        },
        note: { updateMany: jest.fn(), count: jest.fn().mockResolvedValue(0) },
        attachment: { updateMany: jest.fn(), count: jest.fn().mockResolvedValue(0) },
        annotation: { updateMany: jest.fn() },
        userPublication: { upsert: jest.fn(), deleteMany: jest.fn() },
      };

      const repo = new CommandRepository(mockPrisma as never);
      await repo.update(
        '22222222-2222-4222-8222-222222222222',
        '11111111-1111-4111-8111-111111111118',
        undefined,
        { title: 'Updated Title' },
      );
      expect(itemUpdateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          include: expect.objectContaining({
            attachments: { where: { deletedAt: null }, include: { revisions: true } },
          }),
        }),
      );

      await repo.restore(
        '22222222-2222-4222-8222-222222222222',
        '11111111-1111-4111-8111-111111111118',
      );
      expect(itemUpdateMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          include: expect.objectContaining({
            attachments: { where: { deletedAt: null }, include: { revisions: true } },
          }),
        }),
      );

      await setMyPublicationInClient(
        mockPrisma as never,
        '22222222-2222-4222-8222-222222222222',
        '11111111-1111-4111-8111-111111111118',
        true,
      );
      expect(itemUpdateMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          include: expect.objectContaining({
            attachments: { where: { deletedAt: null } },
          }),
        }),
      );

      const publishOutbox = jest.fn();
      const appendChange = jest.fn();
      const itemService = new ItemService(
        { findById: jest.fn().mockResolvedValue({ id: '11111111-1111-4111-8111-111111111118', itemType: 'journalArticle' }) } as never,
        { update: jest.fn().mockResolvedValue({ id: '11111111-1111-4111-8111-111111111118', title: 'Updated Title', version: 2 }) } as never,
        { executeInTransaction: (fn: (tx: unknown, h: unknown) => unknown) => fn({}, { publishOutbox, appendChange }) } as never,
        {} as never,
      );

      await itemService.updateItem(
        '22222222-2222-4222-8222-222222222222',
        '11111111-1111-4111-8111-111111111118',
        1,
        { title: 'Updated Title', year: 2025 },
      );

      expect(publishOutbox).toHaveBeenCalledWith(
        expect.anything(),
        '11111111-1111-4111-8111-111111111118',
        LIBRARY_EVENT_TYPES.ITEM_UPDATED,
        expect.objectContaining({
          updatedFields: ['title', 'year'],
        }),
      );
    });
  });
});
