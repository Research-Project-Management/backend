import {
  cleanAuthorName,
  splitAuthorString,
  parseCreatorString,
  isNoiseAuthorName,
  sanitizeItemTitle,
  isVietnameseName,
  hasVietnameseDiacritics,
  extractFamilyName,
} from '@/modules/library/shared-kernel/domain/bibliographic.domain';

describe('Author Parsing and Cleaning Suite (bibliographic.domain)', () => {
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

  describe('Vietnamese and East Asian Name Handling', () => {
    it('should detect Vietnamese names with diacritics', () => {
      expect(isVietnameseName('Nguyễn Văn An')).toBe(true);
      expect(isVietnameseName('Trần Thị Mai')).toBe(true);
      expect(isVietnameseName('Võ Nguyên Giáp')).toBe(true);
      expect(isVietnameseName('Đặng Thị Ngọc Thịnh')).toBe(true);
      expect(hasVietnameseDiacritics('Nguyễn')).toBe(true);
      expect(hasVietnameseDiacritics('Smith')).toBe(false);
    });

    it('should detect unaccented Vietnamese names', () => {
      expect(isVietnameseName('Nguyen Van An')).toBe(true);
      expect(isVietnameseName('Tran Thi Mai')).toBe(true);
      expect(isVietnameseName('Pham Quoc Cuong')).toBe(true);
    });

    it('should correctly parse Vietnamese names in two-field mode (Family Name First)', () => {
      const p = parseCreatorString('Nguyễn Văn An');
      expect(p.lastName).toBe('Nguyễn');
      expect(p.firstName).toBe('Văn An');
      expect(p.fullName).toBe('Nguyễn Văn An');
      expect(p.fieldMode).toBe(0);

      const p2 = parseCreatorString('Trần Thị Mai');
      expect(p2.lastName).toBe('Trần');
      expect(p2.firstName).toBe('Thị Mai');
      expect(p2.fullName).toBe('Trần Thị Mai');
    });

    it('should support Single-Field mode for Vietnamese names when requested', () => {
      const p = parseCreatorString('Nguyễn Văn An', 0, 'author', {
        preferSingleFieldForVietnamese: true,
      });
      expect(p.fieldMode).toBe(1);
      expect(p.lastName).toBe('Nguyễn Văn An');
      expect(p.firstName).toBe('');
      expect(p.fullName).toBe('Nguyễn Văn An');
    });

    it('should correctly extract family names for Vietnamese and Western authors', () => {
      expect(extractFamilyName('Nguyễn Văn An')).toBe('Nguyễn');
      expect(extractFamilyName('Nguyen Van An')).toBe('Nguyen');
      expect(extractFamilyName('Trần Thị Mai')).toBe('Trần');
      // Western order
      expect(extractFamilyName('Donald E. Knuth')).toBe('Knuth');
      expect(extractFamilyName('Knuth, Donald E.')).toBe('Knuth');
    });

    it('should not confuse Western names with Vietnamese names', () => {
      expect(isVietnameseName('Karen Simonyan')).toBe(false);
      expect(isVietnameseName('Andrew Zisserman')).toBe(false);
      expect(isVietnameseName('Martin Luther King Jr.')).toBe(false);
    });
  });
});
