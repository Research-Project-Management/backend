import { ItemTypeRegistryService } from '../../../../src/modules/library/catalog/registry/item-type-registry.service';
import {
  BIBLIOGRAPHIC_ITEM_TYPES,
  SPECIAL_ITEM_TYPES,
  normalizeItemType,
} from '../../../../src/modules/library/catalog/utils/item.utils';

describe('ItemTypeRegistryService & normalizeItemType', () => {
  let registry: ItemTypeRegistryService;

  beforeEach(() => {
    registry = new ItemTypeRegistryService();
  });

  describe('Registry schema definitions', () => {
    it('should report schema version 42', () => {
      expect(registry.getSchemaVersion()).toBe(42);
    });

    it('should have exactly 37 bibliographic item types', () => {
      const bibliographic = registry.getItemTypes({ bibliographicOnly: true });
      expect(bibliographic.length).toBe(37);
      expect(BIBLIOGRAPHIC_ITEM_TYPES.length).toBe(37);
    });

    it('should have 3 special non-bibliographic types', () => {
      expect(SPECIAL_ITEM_TYPES.length).toBe(3);
      expect(registry.isSpecial('attachment')).toBe(true);
      expect(registry.isSpecial('note')).toBe(true);
      expect(registry.isSpecial('annotation')).toBe(true);
    });

    it('should preserve preprint, dataset, computerProgram, and standard as valid bibliographic types', () => {
      expect(registry.isBibliographic('preprint')).toBe(true);
      expect(registry.isBibliographic('dataset')).toBe(true);
      expect(registry.isBibliographic('computerProgram')).toBe(true);
      expect(registry.isBibliographic('standard')).toBe(true);
    });

    it('should return valid ordered fields for journalArticle', () => {
      const fields = registry.getOrderedFields('journalArticle');
      expect(fields.length).toBeGreaterThan(15);
      const titleField = fields.find((f) => f.key === 'title');
      expect(titleField).toBeDefined();
      expect(titleField?.category).toBe('core');
    });

    it('should return valid creator types and primary creator for different types', () => {
      expect(registry.getPrimaryCreatorType('journalArticle')).toBe('author');
      expect(registry.getPrimaryCreatorType('computerProgram')).toBe(
        'programmer',
      );
      expect(registry.getPrimaryCreatorType('patent')).toBe('inventor');
      expect(registry.getPrimaryCreatorType('film')).toBe('director');
      expect(registry.getPrimaryCreatorType('podcast')).toBe('podcaster');
    });

    it('should resolve base semantic mappings across types', () => {
      // conferencePaper proceedingsTitle -> publicationTitle -> journalArticle publicationTitle
      const mapping = registry.resolveBaseFieldMapping(
        'conferencePaper',
        'journalArticle',
        'proceedingsTitle',
      );
      expect(mapping?.targetField).toBe('publicationTitle');
      expect(mapping?.baseSemantic).toBe('publicationTitle');

      // thesis university -> publisher -> book publisher
      const thesisMapping = registry.resolveBaseFieldMapping(
        'thesis',
        'book',
        'university',
      );
      expect(thesisMapping?.targetField).toBe('publisher');
      expect(thesisMapping?.baseSemantic).toBe('publisher');
    });
  });

  describe('normalizeItemType', () => {
    it('should preserve all 37 canonical bibliographic item types intact', () => {
      for (const type of BIBLIOGRAPHIC_ITEM_TYPES) {
        expect(normalizeItemType(type)).toBe(type);
      }
    });

    it('should preserve preprint and dataset without downgrading to journalArticle or document', () => {
      expect(normalizeItemType('preprint')).toBe('preprint');
      expect(normalizeItemType('dataset')).toBe('dataset');
      expect(normalizeItemType('computerProgram')).toBe('computerProgram');
      expect(normalizeItemType('standard')).toBe('standard');
    });

    it('should map aliases correctly', () => {
      expect(normalizeItemType('paper')).toBe('journalArticle');
      expect(normalizeItemType('chapter')).toBe('bookSection');
      expect(normalizeItemType('dissertation')).toBe('thesis');
      expect(normalizeItemType('phdthesis')).toBe('thesis');
      expect(normalizeItemType('software')).toBe('computerProgram');
      expect(normalizeItemType('data')).toBe('dataset');
      expect(normalizeItemType('spec')).toBe('standard');
      expect(normalizeItemType('conference_paper')).toBe('conferencePaper');
    });
  });
});
