import {
  parseCreatorString,
  ParsedCreator,
} from '../../../src/modules/library/items/creator-parser.util';

describe('Catalog Creator Name Parsing & Multi-Cultural Fixtures (T015)', () => {
  describe('Western Standard Names', () => {
    it('should parse comma-separated "LastName, FirstName MiddleName"', () => {
      const parsed = parseCreatorString('Vaswani, Ashish', 0);
      expect(parsed).toEqual({
        orderIndex: 0,
        creatorType: 'author',
        firstName: 'Ashish',
        lastName: 'Vaswani',
        fullName: 'Ashish Vaswani',
      });
    });

    it('should parse direct "FirstName MiddleName LastName"', () => {
      const parsed = parseCreatorString('Noam Shazeer', 1);
      expect(parsed).toEqual({
        orderIndex: 1,
        creatorType: 'author',
        firstName: 'Noam',
        lastName: 'Shazeer',
        fullName: 'Noam Shazeer',
      });
    });

    it('should parse names with initials and middle names', () => {
      const parsed = parseCreatorString('LeCun, Yann A.', 2);
      expect(parsed).toEqual({
        orderIndex: 2,
        creatorType: 'author',
        firstName: 'Yann A.',
        lastName: 'LeCun',
        fullName: 'Yann A. LeCun',
      });
    });
  });

  describe('Institutional & Organizational Collective Authors', () => {
    const orgNames = [
      'The Cancer Genome Atlas Research Network',
      'CERN Collaboration',
      'World Health Organization',
      'OpenAI',
      'Google DeepMind',
      'European Molecular Biology Laboratory',
      'Institute for Health Metrics and Evaluation',
    ];

    for (const org of orgNames) {
      it(`should recognize "${org}" as an unsplit institutional author`, () => {
        const parsed = parseCreatorString(org, 0);
        expect(parsed.fullName).toBe(org);
        expect(parsed.firstName).toBe('');
        expect(parsed.lastName).toBe('');
        expect(parsed.creatorType).toBe('author');
      });
    }
  });

  describe('Non-Western & East Asian Names', () => {
    it('should parse Vietnamese names preserving full compound name', () => {
      const parsed = parseCreatorString('Nguyễn Văn An', 0);
      expect(parsed.fullName).toBe('Nguyễn Văn An');
      expect(parsed.firstName).toBe('Nguyễn Văn');
      expect(parsed.lastName).toBe('An');
    });

    it('should parse Chinese / Japanese Romanized names', () => {
      const parsed = parseCreatorString('He, Kaiming', 0);
      expect(parsed.fullName).toBe('Kaiming He');
      expect(parsed.firstName).toBe('Kaiming');
      expect(parsed.lastName).toBe('He');
    });
  });

  describe('Mononyms & Historical Figures', () => {
    it('should handle single-word mononyms without corruption', () => {
      const parsedPlato = parseCreatorString('Plato', 0);
      expect(parsedPlato).toEqual({
        orderIndex: 0,
        creatorType: 'author',
        firstName: '',
        lastName: 'Plato',
        fullName: 'Plato',
      });

      const parsedAristotle = parseCreatorString('Aristotle', 1);
      expect(parsedAristotle.fullName).toBe('Aristotle');
    });
  });

  describe('Edge Cases & Defensive Handling', () => {
    it('should handle empty or whitespace-only inputs gracefully', () => {
      const parsed = parseCreatorString('   ', 0);
      expect(parsed.fullName).toBe('Unknown');
      expect(parsed.firstName).toBe('');
      expect(parsed.lastName).toBe('');
    });

    it('should preserve creatorType when passed as editor or contributor', () => {
      const parsed = parseCreatorString('Knuth, Donald E.', 0, 'editor');
      expect(parsed.creatorType).toBe('editor');
      expect(parsed.fullName).toBe('Donald E. Knuth');
    });
  });
});
