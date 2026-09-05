import { ItemTypeConversionService } from '../../../../src/modules/library/types/conversion.service';
import { ItemTypeRegistryService } from '../../../../src/modules/library/types/types.service';
import { CatalogRepository } from '../../../../src/modules/library/items/items.repository';

describe('ItemTypeConversionService', () => {
  let service: ItemTypeConversionService;
  let registryService: ItemTypeRegistryService;
  let mockRepo: Partial<CatalogRepository>;

  beforeEach(() => {
    registryService = new ItemTypeRegistryService();
    mockRepo = {
      findById: jest.fn() as any,
      update: jest.fn() as any,
    };
    service = new ItemTypeConversionService(
      registryService,
      mockRepo as CatalogRepository,
    );
  });

  describe('previewConversion', () => {
    it('should map base semantics (journalArticle -> conferencePaper: publicationTitle -> proceedingsTitle)', () => {
      const item = {
        id: 'item-1',
        itemType: 'journalArticle',
        title: 'Deep Residual Learning',
        publicationTitle:
          'IEEE Transactions on Pattern Analysis and Machine Intelligence',
        volume: '40',
        pages: '100-110',
        creators: [{ fullName: 'Kaiming He', creatorType: 'author' }],
      };

      const preview = service.previewConversion(item, 'conferencePaper');

      expect(preview.sourceType).toBe('journalArticle');
      expect(preview.targetType).toBe('conferencePaper');
      expect(preview.projectedItem.title).toBe('Deep Residual Learning');
      expect(preview.projectedItem.proceedingsTitle).toBe(
        'IEEE Transactions on Pattern Analysis and Machine Intelligence',
      );
      expect(preview.mappedFields).toContainEqual(
        expect.objectContaining({
          fromField: 'publicationTitle',
          toField: 'proceedingsTitle',
          rule: 'base-semantic',
        }),
      );
    });

    it('should handle special rule: book -> bookSection (title -> bookTitle)', () => {
      const item = {
        id: 'item-book-1',
        itemType: 'book',
        title: 'Artificial Intelligence: A Modern Approach',
        publisher: 'Pearson',
        numPages: '1152',
        shortTitle: 'AIMA',
        creators: [{ fullName: 'Stuart Russell', creatorType: 'author' }],
      };

      const preview = service.previewConversion(item, 'bookSection');

      expect(preview.projectedItem.bookTitle).toBe(
        'Artificial Intelligence: A Modern Approach',
      );
      expect(preview.projectedItem.title).toBe('');
      expect(preview.projectedItem.shortTitle).toBeUndefined();
      expect(preview.projectedItem.publisher).toBe('Pearson');
    });

    it('should convert creator roles fallback when target type does not support source role', () => {
      // artwork uses artist, not programmer
      const item = {
        id: 'prog-1',
        itemType: 'computerProgram',
        title: 'Antigravity IDE',
        creators: [
          { fullName: 'Jane Doe', creatorType: 'programmer' },
          { fullName: 'Bob Smith', creatorType: 'programmer' },
        ],
      };

      const preview = service.previewConversion(item, 'artwork');

      expect(preview.projectedItem.creators[0].creatorType).toBe('artist'); // primary role for artwork
      expect(preview.projectedItem.creators[1].creatorType).toBe('contributor'); // secondary fallback
    });

    it('should reject conversion to special child types (attachment, note, annotation)', () => {
      const item = {
        id: 'p1',
        itemType: 'journalArticle',
        title: 'A paper',
      };

      expect(() => service.previewConversion(item, 'attachment')).toThrow(
        /Cannot convert to special non-bibliographic item type/,
      );
    });
  });

  describe('convertItemType', () => {
    it('should execute conversion and update repository atomically', async () => {
      const item = {
        id: 'paper-123',
        workspaceId: 'ws-1',
        itemType: 'preprint',
        title: 'Attention is all you need',
        repository: 'arXiv',
        extraFields: { repository: 'arXiv' },
        creators: [{ fullName: 'Ashish Vaswani', creatorType: 'author' }],
      };

      (mockRepo.findById as any).mockResolvedValue(item);
      (mockRepo.update as any).mockResolvedValue({
        ...item,
        itemType: 'journalArticle',
        type: 'journalArticle',
      });

      const res = await service.convertItemType(
        'ws-1',
        'paper-123',
        'journalArticle',
      );

      expect(res.success).toBe(true);
      expect(res.item.itemType).toBe('journalArticle');
      expect(mockRepo.update).toHaveBeenCalledWith(
        'ws-1',
        'paper-123',
        undefined,
        expect.objectContaining({
          itemType: 'journalArticle',
        }),
        undefined,
      );
    });
  });
});
