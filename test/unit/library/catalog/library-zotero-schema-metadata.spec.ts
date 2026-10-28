import { TypesService } from '@/modules/library/catalog/services/types.service';
import { ZoteroSchemaValidatorService } from '@/modules/library/catalog/services/zotero-schema-validator.service';
import { ItemTransformer } from '@/modules/library/catalog/domain/item.transformer';

describe('Library Zotero Schema & Metadata — Single Source of Truth Suite', () => {
  let typesService: TypesService;
  let validator: ZoteroSchemaValidatorService;
  let transformer: ItemTransformer;

  beforeEach(() => {
    typesService = new TypesService();
    validator = new ZoteroSchemaValidatorService(typesService);
    transformer = new ItemTransformer(typesService);
  });

  describe('1. Zotero Schema v42 Coverage & Single Source of Truth', () => {
    it('should register all 37 Zotero bibliographic types', () => {
      const snapshot = typesService.getSnapshot();
      expect(snapshot.version).toBe(42);
      const bibliographicTypes = Object.values(snapshot.itemTypes).filter(
        (t) => t.isBibliographic,
      );
      expect(bibliographicTypes.length).toBe(37);
    });

    it('should correctly identify valid fields for specific item types', () => {
      // journalArticle has volume and issue, but not patentNumber
      expect(typesService.isValidFieldForType('journalArticle', 'volume')).toBe(
        true,
      );
      expect(typesService.isValidFieldForType('journalArticle', 'issue')).toBe(
        true,
      );
      expect(
        typesService.isValidFieldForType('journalArticle', 'patentNumber'),
      ).toBe(false);

      // patent has patentNumber, assignee, and issuingAuthority
      expect(typesService.isValidFieldForType('patent', 'patentNumber')).toBe(
        true,
      );
      expect(typesService.isValidFieldForType('patent', 'assignee')).toBe(true);
      expect(typesService.isValidFieldForType('patent', 'volume')).toBe(false);
    });
  });

  describe('2. Sanitization & Partial Update Invariants', () => {
    it('should NOT inject empty creators array on field-only partial update', () => {
      const result = validator.validateAndSanitizeItem('journalArticle', {
        volume: '15',
        pages: '100-110',
      });

      expect(result.valid).toBe(true);
      expect(result.sanitizedItem.volume).toBe('15');
      expect(result.sanitizedItem.pages).toBe('100-110');
      // Must not inject empty creators: []
      expect(result.sanitizedItem.creators).toBeUndefined();
    });

    it('should demote invalid fields into extra without data loss', () => {
      const result = validator.validateAndSanitizeItem('patent', {
        patentNumber: 'US1234567',
        unknownCustomField: 'SpecialValue',
      });

      expect(result.valid).toBe(true);
      expect(result.sanitizedItem.patentNumber).toBe('US1234567');
      // Demoted into extra and demotedToExtra
      expect(result.sanitizedItem.extra).toContain(
        'unknownCustomField: SpecialValue',
      );
      expect(result.demotedToExtra.unknownCustomField).toBe('SpecialValue');
    });
  });

  describe('3. Item Type Conversion & Type Leakage Prevention', () => {
    it('should format dropped fields into extra and extraFields during previewConversion', () => {
      const rawArticle = {
        itemType: 'journalArticle',
        title: 'Deep Learning Advances',
        publicationTitle: 'Nature Machine Intelligence',
        volume: '42',
        issue: '3',
        pages: '100-115',
        creators: [{ name: 'LeCun, Yann', creatorType: 'author' }],
      };

      const preview = transformer.previewConversion(rawArticle, 'patent', {
        retainUnmappedInExtra: true,
      });

      expect(preview.targetType).toBe('patent');
      expect(preview.hasLoss).toBe(true);
      expect(preview.droppedFields.some((f) => f.field === 'volume')).toBe(
        true,
      );
      expect(preview.droppedFields.some((f) => f.field === 'issue')).toBe(true);

      // Verify unmapped fields are safely preserved in extra
      const projected = preview.projectedItem as Record<string, any>;
      expect(projected.extra).toContain('Volume: 42');
      expect(projected.extra).toContain('Issue: 3');
      expect(projected.extraFields.__unmapped_journalArticle_volume).toBe('42');
    });

    it('should purge old type-specific fields when converting types', () => {
      const rawItem = {
        id: 'item-123',
        userId: 'user-123',
        title: 'Quantum Neural Networks',
        itemType: 'journalArticle',
        publicationTitle: 'Physical Review Letters',
        volume: '99',
        issue: '2',
        pages: '123-130',
        tags: ['quantum', 'ml'],
        notes: [{ id: 'n1', content: 'Important paper' }],
      };

      const preview = transformer.previewConversion(rawItem, 'patent', {
        retainUnmappedInExtra: true,
      });

      expect(preview.targetType).toBe('patent');
      const projected = preview.projectedItem as Record<string, any>;
      // Old journalArticle fields volume and issue do NOT exist on patent and must be purged
      expect(projected.volume).toBeUndefined();
      expect(projected.issue).toBeUndefined();
      // 'pages' is valid for patent per Zotero schema and is correctly preserved
      expect(projected.pages).toBe('123-130');
      // Unmapped fields must be preserved in extra
      expect(projected.extra).toContain('Volume: 99');
    });
  });

  describe('4. Loop 2 Output Layer Invariants (Catalog Mappers & Schema Validator)', () => {
    it('rejects malformed identifiers in cleanSingleIdentifier and respects explicit clearing over stale extra', async () => {
      const {
        cleanSingleIdentifier,
        normalizeItemIdentifiers,
        syncMetadataIdentifierAliases,
      } = await import(
        '@/modules/library/catalog/domain/identifier-change.helper'
      );
      const { normalizeDoi } = await import('@/modules/library/core');

      expect(cleanSingleIdentifier('not-a-valid-doi', normalizeDoi)).toBe('');

      const clearedIds = normalizeItemIdentifiers({
        doi: '',
        isbn: null,
        extraFields: { doi: '10.1000/stale', isbn: '978-0-262-03384-8' },
        extra: 'DOI: 10.1000/stale\nISBN: 978-0-262-03384-8\nCustom: Value',
      });
      expect(clearedIds.doi).toBe('');
      expect(clearedIds.isbn).toBe('');

      const meta: Record<string, unknown> = {
        doi: '10.1000/stale',
        DOI: '10.1000/stale',
        isbn: '978-0-262-03384-8',
        extra: 'DOI: 10.1000/stale\nISBN: 978-0-262-03384-8\nCustom: Value',
      };
      syncMetadataIdentifierAliases(meta, clearedIds, { isCreate: false });
      expect(meta.doi).toBeNull();
      expect(meta.DOI).toBeUndefined();
      expect(meta.isbn).toBeNull();
      expect(meta.extra).toBe('Custom: Value');
    });

    it('prioritizes concrete baseMap fields and prevents stale data.metadata from clobbering explicit updates', async () => {
      const {
        resolveCanonicalCommandFields,
        buildMetadataPartial,
        normalizeItemIdentifiers,
      } = await import(
        '@/modules/library/catalog/domain/command-payload.builder'
      );

      const updateData = {
        itemType: 'bookSection',
        bookTitle: 'Updated Handbook of AI',
        publicationTitle: 'Stale Book Title',
        metadata: {
          publicationTitle: 'Stale Book Title',
          bookTitle: 'Stale Book Title',
          volume: '1',
        },
        volume: '2',
      };
      const canonical = resolveCanonicalCommandFields(updateData as any, 'bookSection');
      expect(canonical.rawPubTitle).toBe('Updated Handbook of AI');

      const ids = normalizeItemIdentifiers(updateData as any);
      const builtMeta = buildMetadataPartial({
        mode: 'update',
        baseMeta: { publicationTitle: 'Stale Book Title', volume: '1' },
        data: updateData as any,
        canonical,
        ids,
      });
      expect(builtMeta.publicationTitle).toBe('Updated Handbook of AI');
      expect(builtMeta.bookTitle).toBe('Updated Handbook of AI');
      expect(builtMeta.volume).toBe('2');
    });

    it('harmonizes all patent co-authors to inventor and supports snake_case / synonym creator roles', () => {
      const patentResult = validator.validateAndHarmonizeCreators('patent', [
        { firstName: 'Nikola', lastName: 'Tesla', creatorType: 'author' },
        { firstName: 'Thomas', lastName: 'Edison', creatorType: 'co_author' },
      ]);
      expect(patentResult.creators[0].creatorType).toBe('inventor');
      expect(patentResult.creators[1].creatorType).toBe('inventor');

      const bookSectionResult = validator.validateAndHarmonizeCreators(
        'bookSection',
        [
          { firstName: 'Jane', lastName: 'Doe', creatorType: 'book_author' },
          { firstName: 'John', lastName: 'Smith', creatorType: 'advisor' },
        ],
      );
      expect(bookSectionResult.creators[0].creatorType).toBe('bookAuthor');
      expect(bookSectionResult.creators[1].creatorType).toBe('contributor');
    });
  });
});
