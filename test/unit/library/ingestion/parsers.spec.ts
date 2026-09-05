import { DoiParser } from '@/modules/library/ingestion/parsers/doi.parser';
import { RisParser } from '@/modules/library/ingestion/parsers/ris.parser';
import { BibtexParser } from '@/modules/library/ingestion/parsers/bibtex.parser';

describe('Library Ingestion Parsers', () => {
  describe('DoiParser', () => {
    let parser: DoiParser;

    beforeEach(() => {
      parser = new DoiParser();
    });

    it('normalizes raw DOIs with URL resolver prefixes and whitespace', () => {
      expect(
        parser.normalize('  https://doi.org/10.1038/s41586-020-2003-4 '),
      ).toBe('10.1038/s41586-020-2003-4');
      expect(
        parser.normalize('http://dx.doi.org/10.1145/3372278.3390678'),
      ).toBe('10.1145/3372278.3390678');
      expect(parser.normalize('doi: 10.1016/J.CELL.2020.02.052.')).toBe(
        '10.1016/j.cell.2020.02.052',
      );
    });

    it('rejects invalid DOI format strings', () => {
      expect(() => parser.normalize('not-a-doi')).toThrow();
      expect(() => parser.normalize('')).toThrow();
      expect(parser.isValid('invalid-doi')).toBe(false);
      expect(parser.isValid('10.1038/s41586-020-2003-4')).toBe(true);
    });
  });

  describe('RisParser', () => {
    let parser: RisParser;

    beforeEach(() => {
      parser = new RisParser();
    });

    it('parses multi-field RIS records accurately', () => {
      const risContent = `
TY  - JOUR
TI  - Deep Residual Learning for Image Recognition
AU  - He, Kaiming
AU  - Zhang, Xiangyu
AU  - Ren, Shaoqing
AU  - Sun, Jian
JO  - IEEE Conference on Computer Vision and Pattern Recognition
PY  - 2016
VL  - 1
IS  - 1
SP  - 770
EP  - 778
DO  - 10.1109/CVPR.2016.90
KW  - Deep Learning
KW  - Computer Vision
AB  - Deeper neural networks are more difficult to train.
ER  - 
`;

      const results = parser.parse(risContent);
      expect(results).toHaveLength(1);
      const record = results[0];
      expect(record.title).toBe('Deep Residual Learning for Image Recognition');
      expect(record.doi).toBe('10.1109/CVPR.2016.90');
      expect(record.year).toBe(2016);
      expect(record.pages).toBe('770-778');
      expect(record.authors).toEqual([
        'He, Kaiming',
        'Zhang, Xiangyu',
        'Ren, Shaoqing',
        'Sun, Jian',
      ]);
      expect(record.creators).toHaveLength(4);
      expect(record.creators![0].firstName).toBe('Kaiming');
      expect(record.creators![0].lastName).toBe('He');
      expect(record.tags).toEqual(['Deep Learning', 'Computer Vision']);
    });
  });

  describe('BibtexParser', () => {
    let parser: BibtexParser;

    beforeEach(() => {
      parser = new BibtexParser();
    });

    it('parses standard BibTeX entry with author list, year, and journal', () => {
      const bibtex = `
@article{vaswani2017attention,
  title={Attention is all you need},
  author={Vaswani, Ashish and Shazeer, Noam and Parmar, Niki and Uszkoreit, Jakob},
  journal={Advances in neural information processing systems},
  volume={30},
  year={2017},
  doi={10.5555/3295222.3295349}
}
`;
      const results = parser.parse(bibtex);
      expect(results).toHaveLength(1);
      const entry = results[0];
      expect(entry.citationKey).toBe('vaswani2017attention');
      expect(entry.title).toBe('Attention is all you need');
      expect(entry.year).toBe(2017);
      expect(entry.authors).toHaveLength(4);
      expect(entry.doi).toBe('10.5555/3295222.3295349');
    });

    it('preserves language, editor, place, edition, and series from BibTeX', () => {
      const bibtex = `
@book{knuth1997art,
  title={The Art of Computer Programming},
  author={Knuth, Donald E.},
  editor={Guy, Richard K.},
  publisher={Addison-Wesley},
  address={Boston, MA},
  year={1997},
  edition={3rd},
  series={The Art of Computer Programming Series},
  language={english},
  isbn={978-0201896831}
}
`;
      const results = parser.parse(bibtex);
      expect(results).toHaveLength(1);
      const entry = results[0];
      expect(entry.title).toBe('The Art of Computer Programming');
      expect(entry.authors).toContain('Donald E. Knuth');
      expect(entry.publisher).toBe('Addison-Wesley');
      expect(entry.language).toBe('english');
      expect(entry.isbn).toBe('978-0201896831');
      expect(entry.edition).toBe('3rd');
      expect(entry.series).toBe('The Art of Computer Programming Series');
      expect(entry.editors).toBeDefined();
      expect(entry.editors![0]).toContain('Guy');
    });
  });

  describe('RisParser comprehensive field preservation', () => {
    let parser: RisParser;

    beforeEach(() => {
      parser = new RisParser();
    });

    it('extracts language, isbn, publisher, place, edition, editors, and call number in RIS', () => {
      const ris = `
TY  - BOOK
TI  - Concrete Mathematics: A Foundation for Computer Science
AU  - Graham, Ronald L.
AU  - Knuth, Donald E.
AU  - Patashnik, Oren
ED  - Smith, John
PB  - Addison-Wesley
CY  - Reading, MA
PY  - 1994
SN  - 978-0201558029
LA  - en
ET  - 2nd
CN  - QA39.2 .G733 1994
ER  - 
`;
      const results = parser.parse(ris);
      expect(results).toHaveLength(1);
      const item = results[0];
      expect(item.title).toBe('Concrete Mathematics: A Foundation for Computer Science');
      expect(item.authors).toHaveLength(3);
      expect(item.publisher).toBe('Addison-Wesley');
      expect(item.place).toBe('Reading, MA');
      expect(item.year).toBe(1994);
      expect(item.isbn).toBe('978-0201558029');
      expect(item.language).toBe('en');
      expect(item.edition).toBe('2nd');
      expect(item.callNumber).toBe('QA39.2 .G733 1994');
      expect(item.editors).toBeDefined();
      expect(item.editors![0]).toContain('Smith');
    });
  });
});
