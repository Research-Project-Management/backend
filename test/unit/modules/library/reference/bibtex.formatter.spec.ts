import { BibtexFormatter } from '@/modules/library/reference/formatters/bibtex.formatter';

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

    it('should handle single author single word names', () => {
      const key = formatter.generateCitationKey('Survey on LLMs', ['Plato'], 2024);
      expect(key).toBe('plato2024llms');
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
