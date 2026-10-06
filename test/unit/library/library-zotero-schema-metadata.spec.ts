import { TypesService } from '@/modules/library/catalog/core/services/types.service';
import { ZoteroSchemaValidatorService } from '@/modules/library/catalog/core/services/zotero-schema-validator.service';
import { ItemTransformer } from '@/modules/library/catalog/core/adapters/item.transformer';
import { ItemAggregate } from '@/modules/library/catalog/core/domain/item.aggregate';
import { ConvertItemTypeUseCase } from '@/modules/library/catalog/core/use-cases/convert-item-type.use-case';
import { IItemRepositoryPort as IItemRepository } from '@/modules/library/catalog/core/ports/item-repository.port';

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

    it('should purge old type-specific fields on aggregate when replaceFields is true', async () => {
      // Create initial aggregate as journalArticle with volume and issue
      const aggregate = ItemAggregate.create({
        userId: 'user-123',
        title: 'Quantum Neural Networks',
        itemType: 'journalArticle',
        publicationTitle: 'Physical Review Letters',
        fields: {
          volume: '99',
          issue: '2',
          pages: '123-130',
          tags: ['quantum', 'ml'],
          notes: [{ id: 'n1', content: 'Important paper' }],
        },
      });

      expect(aggregate.fields.volume).toBe('99');
      expect(aggregate.fields.issue).toBe('2');

      const mockRepo = {
        findById: jest.fn().mockResolvedValue(aggregate),
        save: jest.fn().mockImplementation(async (item) => item),
        delete: jest.fn(),
        findDuplicateCandidates: jest.fn(),
      } as unknown as IItemRepository;

      const useCase = new ConvertItemTypeUseCase(
        mockRepo,
        typesService,
        transformer,
      );

      const result = await useCase.execute({
        userId: aggregate.userId,
        itemId: aggregate.id,
        targetType: 'patent',
        options: { retainUnmappedInExtra: true },
      });

      expect(result.success).toBe(true);
      expect(aggregate.itemType).toBe('patent');

      // CRITICAL: Old journalArticle fields volume and issue do NOT exist on patent and must be purged
      expect(aggregate.fields.volume).toBeUndefined();
      expect(aggregate.fields.issue).toBeUndefined();
      // 'pages' is valid for patent per Zotero schema and is correctly preserved
      expect(aggregate.fields.pages).toBe('123-130');

      // Persistent internal fields (tags, notes) must remain intact
      expect(aggregate.tags).toEqual(['quantum', 'ml']);
      expect(aggregate.notes.length).toBe(1);

      // Unmapped fields must be preserved in extra
      expect(aggregate.fields.extra).toContain('Volume: 99');
    });
  });
});
