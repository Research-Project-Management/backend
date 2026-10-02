import {
  cleanAuthorName,
  splitAuthorString,
  parseCreatorString,
  isNoiseAuthorName,
  sanitizeItemTitle,
} from '@/modules/library/shared-kernel/utils/bibliographic.utils';

describe('Author Parsing and Cleaning Suite (bibliographic.utils)', () => {
  describe('cleanAuthorName', () => {
    it('should strip footnote markers, affiliation numbers, and OCR superscripts', () => {
      expect(cleanAuthorName('Karen Simonyan 1,2*')).toBe('Karen Simonyan');
      expect(cleanAuthorName('Andrew Zisserman *†')).toBe('Andrew Zisserman');
      expect(cleanAuthorName('Jakob Uszkoreit 1')).toBe('Jakob Uszkoreit');
      expect(cleanAuthorName('Illia Polosukhin2')).toBe('Illia Polosukhin');
    });

    it('should strip emails, roles, and academic titles', () => {
      expect(cleanAuthorName('John Doe <john@ox.ac.uk>')).toBe('John Doe');
      expect(cleanAuthorName('Jane Doe (corresponding author)')).toBe(
        'Jane Doe',
      );
      expect(cleanAuthorName('1. Ashish Vaswani')).toBe('Ashish Vaswani');
      expect(cleanAuthorName('Prof. Dr. Donald E. Knuth, PhD')).toBe(
        'Donald E. Knuth',
      );
    });

    it('should preserve legitimate generational suffixes', () => {
      expect(cleanAuthorName('Martin Luther King Jr.')).toBe(
        'Martin Luther King Jr.',
      );
      expect(cleanAuthorName('Donald Knuth III')).toBe('Donald Knuth III');
    });

    it('should reject noise author names, affiliations, and OCR artifacts', () => {
      expect(isNoiseAuthorName('A B S T R A C T')).toBe(true);
      expect(isNoiseAuthorName('A BSTRACT')).toBe(true);
      expect(isNoiseAuthorName('ABSTRACT')).toBe(true);
      expect(isNoiseAuthorName('Visual Geometry Group')).toBe(true);
      expect(isNoiseAuthorName('Department of Engineering Science')).toBe(true);
      expect(
        isNoiseAuthorName(
          'University of Oxford, Department of Engineering Science',
        ),
      ).toBe(true);
      expect(isNoiseAuthorName('Keywords')).toBe(true);
      expect(isNoiseAuthorName('References')).toBe(true);
      expect(isNoiseAuthorName('Karen Simonyan')).toBe(false);
      expect(isNoiseAuthorName('Andrew Zisserman')).toBe(false);

      expect(cleanAuthorName('A B S T R A C T')).toBe('');
      expect(cleanAuthorName('Author: A BSTRACT')).toBe('');
      expect(cleanAuthorName('Visual Geometry Group')).toBe('');

      expect(
        splitAuthorString(
          'Karen Simonyan, Andrew Zisserman, A BSTRACT, Visual Geometry Group',
        ),
      ).toEqual(['Karen Simonyan', 'Andrew Zisserman']);
    });
  });

  describe('splitAuthorString', () => {
    it('should split semicolon-separated authors', () => {
      expect(splitAuthorString('Simonyan, Karen; Zisserman, Andrew')).toEqual([
        'Simonyan, Karen',
        'Zisserman, Andrew',
      ]);
    });

    it('should split authors with Oxford comma and conjunctions', () => {
      expect(
        splitAuthorString('Ashish Vaswani, Noam Shazeer, and Niki Parmar'),
      ).toEqual(['Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar']);

      expect(
        splitAuthorString('Vaswani, Ashish and Shazeer, Noam & Parmar, Niki'),
      ).toEqual(['Vaswani, Ashish', 'Shazeer, Noam', 'Parmar, Niki']);
    });

    it('should disambiguate two forward-ordered authors vs single inverted author', () => {
      // Two forward authors with comma in between
      expect(splitAuthorString('Karen Simonyan, Andrew Zisserman')).toEqual([
        'Karen Simonyan',
        'Andrew Zisserman',
      ]);

      // Single inverted author
      expect(splitAuthorString('Simonyan, Karen')).toEqual(['Simonyan, Karen']);

      // Generational suffix with comma
      expect(splitAuthorString('Martin Luther King, Jr.')).toEqual([
        'Martin Luther King, Jr.',
      ]);
    });

    it('should properly pair alternating inverted authors with initials', () => {
      expect(splitAuthorString('Vaswani, A., Shazeer, N., Parmar, N.')).toEqual(
        ['Vaswani, A.', 'Shazeer, N.', 'Parmar, N.'],
      );

      expect(
        splitAuthorString('Vaswani, Ashish, Shazeer, Noam, Parmar, Niki'),
      ).toEqual(['Vaswani, Ashish', 'Shazeer, Noam', 'Parmar, Niki']);
    });
  });

  describe('parseCreatorString', () => {
    it('should correctly parse forward and inverted names', () => {
      const p1 = parseCreatorString('Donald E. Knuth');
      expect(p1.firstName).toBe('Donald E.');
      expect(p1.lastName).toBe('Knuth');
      expect(p1.fullName).toBe('Donald E. Knuth');

      const p2 = parseCreatorString('Knuth, Donald E.');
      expect(p2.firstName).toBe('Donald E.');
      expect(p2.lastName).toBe('Knuth');
      expect(p2.fullName).toBe('Donald E. Knuth');
    });

    it('should identify institutions and set fieldMode=1', () => {
      const p = parseCreatorString('Google DeepMind');
      expect(p.fieldMode).toBe(1);
      expect(p.fullName).toBe('Google DeepMind');
    });

    it('should clean footnote noise during creator parsing', () => {
      const p = parseCreatorString('Karen Simonyan 1,2*');
      expect(p.firstName).toBe('Karen');
      expect(p.lastName).toBe('Simonyan');
      expect(p.fullName).toBe('Karen Simonyan');
    });
  });

  describe('sanitizeItemTitle', () => {
    it('should normalize spaced hyphens and OCR gaps in titles', () => {
      expect(sanitizeItemTitle('Large - Scale Image Recognition')).toBe(
        'Large-Scale Image Recognition',
      );
      expect(sanitizeItemTitle('Auto - Encoding Variational Bayes')).toBe(
        'Auto-Encoding Variational Bayes',
      );
      expect(
        sanitizeItemTitle(
          'Very Deep Convolutional Networks for Large - Scale Image Recognition',
        ),
      ).toBe(
        'Very Deep Convolutional Networks for Large-Scale Image Recognition',
      );
    });
  });
});
