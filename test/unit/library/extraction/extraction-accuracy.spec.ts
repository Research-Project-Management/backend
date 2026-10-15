import {
  isPlausibleAuthorName,
  splitConcatenatedAuthors,
  yearFromArxivId,
  repairFragmentedTitle,
} from '@/modules/library/shared-kernel/domain/bibliographic.domain';

describe('PDF first-page accuracy helpers', () => {
  describe('yearFromArxivId', () => {
    it.each([
      ['1706.03762', 2017],
      ['1512.03385', 2015],
      ['1412.6980', 2014],
      ['2001.08361', 2020],
      ['1406.2661', 2014],
      ['math/0303109', 2003],
      ['hep-th/9901001', 1999],
    ])('%s -> %i', (id, year) => {
      expect(yearFromArxivId(id)).toBe(year);
    });

    it('rejects impossible months and missing ids', () => {
      expect(yearFromArxivId('1713.00001')).toBeUndefined();
      expect(yearFromArxivId('')).toBeUndefined();
      expect(yearFromArxivId(undefined)).toBeUndefined();
    });
  });

  describe('splitConcatenatedAuthors', () => {
    it('splits the ResNet author run (4 names, no delimiter)', () => {
      expect(
        splitConcatenatedAuthors(
          'Kaiming He Xiangyu Zhang Shaoqing Ren Jian Sun',
          4,
        ),
      ).toEqual(['Kaiming He', 'Xiangyu Zhang', 'Shaoqing Ren', 'Jian Sun']);
    });

    it('splits the BERT author run with a hyphenated given name', () => {
      expect(
        splitConcatenatedAuthors(
          'Jacob Devlin Ming-Wei Chang Kenton Lee Kristina Toutanova',
          4,
        ),
      ).toEqual([
        'Jacob Devlin',
        'Ming-Wei Chang',
        'Kenton Lee',
        'Kristina Toutanova',
      ]);
    });

    it('keeps middle initials attached (Scaling Laws run)', () => {
      expect(
        splitConcatenatedAuthors(
          'Tom Henighan Tom B. Brown Benjamin Chess Rewon Child',
        ),
      ).toEqual([
        'Tom Henighan',
        'Tom B. Brown',
        'Benjamin Chess',
        'Rewon Child',
      ]);
    });

    it('keeps lowercase name particles with the surname', () => {
      expect(
        splitConcatenatedAuthors('Anna Smith Pieter van der Berg Li Wei', 4),
      ).toEqual(['Anna Smith', 'Pieter van der Berg', 'Li Wei']);
    });

    it('falls back to the original string when a name cannot be paired', () => {
      // "Li Wei Chen" leaves a dangling token -> ambiguous -> untouched
      expect(
        splitConcatenatedAuthors(
          'Anna Smith Pieter van der Berg Li Wei Chen',
          4,
        ),
      ).toEqual(['Anna Smith Pieter van der Berg Li Wei Chen']);
    });

    it('does not touch delimited lists, short strings, or institutions', () => {
      expect(splitConcatenatedAuthors('Ashish Vaswani, Noam Shazeer')).toEqual([
        'Ashish Vaswani, Noam Shazeer',
      ]);
      expect(splitConcatenatedAuthors('Jacob Devlin')).toEqual([
        'Jacob Devlin',
      ]);
      expect(
        splitConcatenatedAuthors(
          'Stanford University Computer Science Department',
          4,
        ),
      ).toHaveLength(1);
    });

    it('returns the input unchanged when it does not parse cleanly', () => {
      // odd token count -> ambiguous -> leave alone
      expect(
        splitConcatenatedAuthors('Maria Del Carmen Lopez Garcia', 4),
      ).toEqual(['Maria Del Carmen Lopez Garcia']);
    });
  });

  describe('isPlausibleAuthorName', () => {
    it('accepts real names', () => {
      for (const n of [
        'Diederik P. Kingma',
        'Jimmy Lei Ba',
        'Pieter van der Berg',
        'Łukasz Kaiser',
        'Ming-Wei Chang',
      ]) {
        expect(isPlausibleAuthorName(n)).toBe(true);
      }
    });

    it('rejects abstract prose that bled into the author block', () => {
      expect(isPlausibleAuthorName('We introduce Adam')).toBe(false);
      expect(
        isPlausibleAuthorName('an algorithm for first-order gradient-based'),
      ).toBe(false);
    });
  });

  describe('repairFragmentedTitle', () => {
    const page = [
      'Published as a conference paper at ICLR 2015',
      'ADAM: A METHOD FOR STOCHASTIC OPTIMIZATION',
      'Diederik P. Kingma*',
    ].join('\n');

    it('repairs a small-caps fragmented title when the text layer proves it', () => {
      expect(
        repairFragmentedTitle(
          'A Dam : A M Ethod for S Tochastic O Ptimization',
          page,
        ),
      ).toBe('ADAM: A METHOD FOR STOCHASTIC OPTIMIZATION');
    });

    it('never alters a legitimate title that merely starts with "A"', () => {
      expect(
        repairFragmentedTitle(
          'A Survey of Deep Learning',
          'A Survey of Deep Learning',
        ),
      ).toBeUndefined();
      expect(
        repairFragmentedTitle('A B Testing for A I Systems', 'unrelated text'),
      ).toBeUndefined();
    });
  });
});
