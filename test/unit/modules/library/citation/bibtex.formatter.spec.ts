import { BibtexFormatter } from '@/modules/library/citation/formatters/bibtex.formatter';

describe('BibtexFormatter', () => {
  let formatter: BibtexFormatter;

  beforeEach(() => {
    formatter = new BibtexFormatter();
  });

  describe('generateCitationKey (Better BibTeX Standards)', () => {
    it('should extract family name correctly from "First Last" and filter stop words', () => {
      const key = formatter.generateCitationKey(
        'Attention Is All You Need',
        ['Ashish Vaswani', 'Noam Shazeer'],
        2017,
      );
      expect(key).toBe('vaswani2017attention');
    });

    it('should extract family name correctly from "Last, First"', () => {
      const key = formatter.generateCitationKey(
        'Deep Residual Learning for Image Recognition',
        ['He, Kaiming', 'Zhang, Xiangyu'],
        2016,
      );
      expect(key).toBe('he2016deep');
    });

    it('should filter stop words like "A", "The", "On", "Towards"', () => {
      const key = formatter.generateCitationKey(
        'A Novel Approach to Neural Networks',
        ['Geoffrey Hinton'],
        2015,
      );
      expect(key).toBe('hinton2015neural');
    });

    it('should normalize Vietnamese diacritics and accented characters', () => {
      const key = formatter.generateCitationKey(
        'Nghiên Cứu Về Mô Hình Ngôn Ngữ Lớn',
        ['Nguyễn, Văn An'],
        2023,
      );
      expect(key).toBe('nguyen2023nghien');
    });

    it('should fallback to nodate when year is missing or null', () => {
      const key = formatter.generateCitationKey(
        'Quantum Computing Principles',
        ['Feynman, Richard'],
        null,
      );
      expect(key).toBe('feynmannodatequantum');
    });
  });

  describe('formatEntry', () => {
    it('should format full BibTeX entry with series, abstract, and DOI', () => {
      const entry = formatter.formatEntry({
        title: 'Deep Residual Learning',
        authors: ['Kaiming He', 'Xiangyu Zhang'],
        year: 2016,
        journal: 'CVPR',
        volume: '1',
        pages: '770-778',
        doi: '10.1109/CVPR.2016.90',
        series: 'Lecture Notes in CS',
        abstract: 'Deep networks are difficult to train.',
        itemType: 'conferencePaper',
      });

      expect(entry).toContain('@inproceedings{he2016deep,');
      expect(entry).toContain('title = {Deep Residual Learning}');
      expect(entry).toContain('author = {Kaiming He and Xiangyu Zhang}');
      expect(entry).toContain('series = {Lecture Notes in CS}');
      expect(entry).toContain(
        'abstract = {Deep networks are difficult to train.}',
      );
      expect(entry).toContain('doi = {10.1109/CVPR.2016.90}');
    });
  });

  describe('escapeTex', () => {
    it('should escape reserved TeX syntax characters', () => {
      const input = 'Research & Development: A 100% $50k #1 {Test} ~ Model ^2';
      const escaped = formatter.escapeTex(input);
      expect(escaped).toContain('\\&');
      expect(escaped).toContain('\\%');
      expect(escaped).toContain('\\$');
      expect(escaped).toContain('\\#');
      expect(escaped).toContain('\\{Test\\}');
      expect(escaped).toContain('\\textasciitilde{}');
      expect(escaped).toContain('\\textasciicircum{}');
    });
  });
});
