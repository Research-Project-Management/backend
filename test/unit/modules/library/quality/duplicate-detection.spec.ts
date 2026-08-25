import { QualityService } from '@/modules/library/quality/quality.service';
import { normalizeQualityTitle } from '@/modules/library/quality/quality.util';
import { extractFamilyName } from '@/modules/library/citation/citation.util';

describe('QualityService — Duplicate Detection Logic', () => {
  let service: QualityService;

  beforeEach(() => {
    service = new QualityService({} as any);
  });

  describe('normalizeQualityTitle helper', () => {
    it('normalizes titles by stripping punctuation, symbols, and whitespace', () => {
      expect(normalizeQualityTitle('Attention Is All You Need!')).toBe(
        'attentionisallyouneed',
      );
      expect(
        normalizeQualityTitle('Attention Is All You Need: Part 1 (NeurIPS 2017)'),
      ).toBe('attentionisallyouneedpart1neurips2017');
      expect(normalizeQualityTitle('')).toBe('');
    });
  });

  describe('extractFamilyName helper', () => {
    it('correctly extracts author family names in Western and BibTeX formats', () => {
      expect(extractFamilyName('Vaswani, Ashish')).toBe('vaswani');
      expect(extractFamilyName('Ashish Vaswani')).toBe('vaswani');
      expect(extractFamilyName('Kaiming He')).toBe('he');
      expect(extractFamilyName('Yoshua Bengio')).toBe('bengio');
      expect(extractFamilyName('')).toBe('author');
    });
  });

  describe('toGroupItem helper', () => {
    it('transforms paper database model into clean duplicate group item', () => {
      const toGroupItem = (service as any).toGroupItem.bind(service);
      const item = toGroupItem({
        id: 'p-1',
        title: 'Sample Paper',
        doi: '10.1234/sample',
        authors: ['Author, One'],
        year: 2024,
        citationKey: 'author2024sample',
        collectionId: 'c-1',
        createdAt: new Date('2026-01-01'),
        attachments: [{}, {}],
      });

      expect(item.id).toBe('p-1');
      expect(item.attachmentsCount).toBe(2);
      expect(item.doi).toBe('10.1234/sample');
    });
  });
});
