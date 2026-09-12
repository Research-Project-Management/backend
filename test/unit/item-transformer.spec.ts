import { ItemTransformer } from '../../src/modules/library/items/transformers/item.transformer';
import { TypesService } from '../../src/modules/library/types/types.service';
import { BadRequestException } from '@nestjs/common';

describe('ItemTransformer (Matt Pocock Pattern)', () => {
  let transformer: ItemTransformer;
  let typesService: TypesService;

  beforeEach(() => {
    typesService = new TypesService();
    transformer = new ItemTransformer(typesService);
  });

  describe('getItemFieldValue', () => {
    it('retrieves values from direct top-level properties', () => {
      const item = { title: 'Direct Title', publicationTitle: 'Nature' };
      expect(transformer.getItemFieldValue(item, 'title')).toBe('Direct Title');
      expect(transformer.getItemFieldValue(item, 'publicationTitle')).toBe(
        'Nature',
      );
    });

    it('retrieves values from extraFields object when not at top-level', () => {
      const item = { title: 'Test', extraFields: { series: 'Physics Series' } };
      expect(transformer.getItemFieldValue(item, 'series')).toBe(
        'Physics Series',
      );
    });

    it('resolves field aliases transparently', () => {
      const item = { journal: 'Science' };
      // journal is alias for publicationTitle
      expect(transformer.getItemFieldValue(item, 'publicationTitle')).toBe(
        'Science',
      );
      expect(transformer.getItemFieldValue(item, 'journal')).toBe('Science');
    });

    it('falls back to case-insensitive key lookup', () => {
      const item = { DOI: '10.1000/182' };
      expect(transformer.getItemFieldValue(item, 'doi')).toBe('10.1000/182');
    });

    it('returns undefined if field does not exist', () => {
      const item = { title: 'Test' };
      expect(
        transformer.getItemFieldValue(item, 'nonExistent'),
      ).toBeUndefined();
    });
  });

  describe('findMatchingTargetField', () => {
    it('finds exact field key matches', () => {
      const targetFields = [
        { key: 'title', label: 'Title' },
        { key: 'abstractNote', label: 'Abstract' },
      ] as any;
      expect(transformer.findMatchingTargetField('title', targetFields)).toBe(
        'title',
      );
    });

    it('resolves alias keys to matching target fields', () => {
      const targetFields = [
        { key: 'publicationTitle', label: 'Publication' },
      ] as any;
      expect(transformer.findMatchingTargetField('journal', targetFields)).toBe(
        'publicationTitle',
      );
    });

    it('matches field keys case-insensitively', () => {
      const targetFields = [{ key: 'doi', label: 'DOI' }] as any;
      expect(transformer.findMatchingTargetField('DOI', targetFields)).toBe(
        'doi',
      );
    });

    it('returns undefined when no matching field is found', () => {
      const targetFields = [{ key: 'title', label: 'Title' }] as any;
      expect(
        transformer.findMatchingTargetField('volume', targetFields),
      ).toBeUndefined();
    });
  });

  describe('previewConversion', () => {
    it('returns identical projection with no loss when source and target types match', () => {
      const item = {
        id: 'item-1',
        itemType: 'journalArticle',
        title: 'Original Article',
        creators: [
          { firstName: 'Alice', lastName: 'Smith', creatorType: 'author' },
        ],
      };
      const result = transformer.previewConversion(item, 'journalArticle');
      expect(result.sourceType).toBe('journalArticle');
      expect(result.targetType).toBe('journalArticle');
      expect(result.hasLoss).toBe(false);
      expect(result.droppedFields).toHaveLength(0);
      expect(result.projectedItem.title).toBe('Original Article');
      expect(result.creatorChanges[0].reason).toBe('preserved');
    });

    it('throws BadRequestException for invalid target type', () => {
      const item = { itemType: 'journalArticle', title: 'Test' };
      expect(() =>
        transformer.previewConversion(item, 'invalidTypeUnknown'),
      ).toThrow(BadRequestException);
    });

    it('throws BadRequestException for non-bibliographic target type', () => {
      const item = { itemType: 'journalArticle', title: 'Test' };
      expect(() => transformer.previewConversion(item, 'attachment')).toThrow(
        BadRequestException,
      );
    });

    it('converts book to bookSection with special title-to-bookTitle mapping', () => {
      const bookItem = {
        id: 'book-1',
        itemType: 'book',
        title: 'The Great Handbook',
        publisher: 'Oxford Press',
        creators: [
          { firstName: 'Jane', lastName: 'Doe', creatorType: 'author' },
        ],
      };

      const result = transformer.previewConversion(bookItem, 'bookSection');
      expect(result.sourceType).toBe('book');
      expect(result.targetType).toBe('bookSection');
      // Special rule: book title becomes bookSection bookTitle, title is cleared
      expect(result.projectedItem.bookTitle).toBe('The Great Handbook');
      expect(result.projectedItem.title).toBe('');
      expect(result.mappedFields).toContainEqual(
        expect.objectContaining({
          fromField: 'title',
          toField: 'bookTitle',
          value: 'The Great Handbook',
          rule: 'special-rule',
        }),
      );
    });

    it('converts bookSection to book with bookTitle-to-title mapping', () => {
      const sectionItem = {
        id: 'section-1',
        itemType: 'bookSection',
        title: 'Chapter 1: Intro',
        bookTitle: 'The Great Handbook',
        creators: [
          { firstName: 'Jane', lastName: 'Doe', creatorType: 'author' },
        ],
      };

      const result = transformer.previewConversion(sectionItem, 'book');
      expect(result.sourceType).toBe('bookSection');
      expect(result.targetType).toBe('book');
      expect(result.projectedItem.title).toBe('The Great Handbook');
      expect(result.mappedFields).toContainEqual(
        expect.objectContaining({
          fromField: 'bookTitle',
          toField: 'title',
          value: 'The Great Handbook',
          rule: 'special-rule',
        }),
      );
    });

    it('preserves persistent academic fields even across different types', () => {
      const item = {
        id: 'art-1',
        itemType: 'journalArticle',
        title: 'Research Paper',
        doi: '10.1234/test.doi',
        arxivId: '2101.00001',
      };

      const result = transformer.previewConversion(item, 'book');
      expect(result.projectedItem.doi).toBe('10.1234/test.doi');
      expect(result.projectedItem.arxivId).toBe('2101.00001');
    });

    it('tracks dropped fields and retains unmapped in extra fields when enabled', () => {
      const item = {
        id: 'art-2',
        itemType: 'journalArticle',
        title: 'A Study',
        issue: '12', // journalArticle specific
        extraFields: {},
      };

      // Book does not have issue
      const result = transformer.previewConversion(item, 'book', {
        retainUnmappedInExtra: true,
      });

      expect(result.hasLoss).toBe(true);
      expect(result.droppedFields).toContainEqual(
        expect.objectContaining({ field: 'issue', value: '12' }),
      );
      expect(
        result.projectedItem.extraFields['__unmapped_journalArticle_issue'],
      ).toBe('12');
    });

    it('handles creator role changes with primary and secondary fallback', () => {
      // In film, director is primary, but when converting to book, author is primary
      const item = {
        id: 'film-1',
        itemType: 'film',
        title: 'Documentary',
        creators: [
          {
            firstName: 'Martin',
            lastName: 'Scorsese',
            creatorType: 'director',
          },
          {
            firstName: 'Roger',
            lastName: 'Deakins',
            creatorType: 'cinematographer',
          },
        ],
      };

      const result = transformer.previewConversion(item, 'book');
      expect(result.hasLoss).toBe(true);
      // Director on index 0 falls back to primary creator ('author' in book)
      expect(result.creatorChanges[0].toRole).toBe('author');
      expect(result.creatorChanges[0].reason).toBe('primary-fallback');
      expect(result.projectedItem.creators[0].creatorType).toBe('author');

      // Cinematographer (not supported in book) falls back to contributor
      expect(result.creatorChanges[1].toRole).toBe('contributor');
      expect(result.creatorChanges[1].reason).toBe('secondary-fallback');
      expect(result.projectedItem.creators[1].creatorType).toBe('contributor');
    });
  });
});
