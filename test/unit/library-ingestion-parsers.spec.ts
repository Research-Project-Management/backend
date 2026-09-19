import { Test, TestingModule } from '@nestjs/testing';
import { DoiParser } from '../../src/modules/library/ingestion/parsers/doi.parser';
import { BibtexParser } from '../../src/modules/library/ingestion/parsers/bibtex.parser';
import { IngestionValidationException } from '../../src/modules/library/ingestion/errors/ingestion.errors';

describe('Library Ingestion Parsers (DoiParser & BibtexParser)', () => {
  let doiParser: DoiParser;
  let bibtexParser: BibtexParser;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [DoiParser, BibtexParser],
    }).compile();

    doiParser = module.get<DoiParser>(DoiParser);
    bibtexParser = module.get<BibtexParser>(BibtexParser);
  });

  describe('DoiParser - Canonical Normalization & SICI Support', () => {
    it('should normalize standard DOI string and strip prefixes', () => {
      expect(doiParser.normalize('10.1038/s41586-020-2649-2')).toBe(
        '10.1038/s41586-020-2649-2',
      );
      expect(
        doiParser.normalize('https://doi.org/10.1038/s41586-020-2649-2'),
      ).toBe('10.1038/s41586-020-2649-2');
      expect(
        doiParser.normalize('http://dx.doi.org/10.1038/s41586-020-2649-2'),
      ).toBe('10.1038/s41586-020-2649-2');
      expect(doiParser.normalize('doi: 10.1038/s41586-020-2649-2.')).toBe(
        '10.1038/s41586-020-2649-2',
      );
    });

    it('should resolve publisher URLs to canonical DOI', () => {
      // Nature URL
      expect(
        doiParser.normalize('https://www.nature.com/articles/nature12373'),
      ).toBe('10.1038/nature12373');
      // Zenodo URL
      expect(doiParser.normalize('https://zenodo.org/records/5554321')).toBe(
        '10.5281/zenodo.5554321',
      );
      // BioRxiv URL
      expect(
        doiParser.normalize(
          'https://www.biorxiv.org/content/10.1101/2020.01.01.123456v2',
        ),
      ).toBe('10.1101/2020.01.01.123456');
    });

    it('should accept early SICI DOIs containing angle brackets (< >)', () => {
      const siciDoi =
        '10.1002/1097-0142(19901001)66:7<1411::AID-CNCR2820660702>3.0.CO;2-9';
      expect(doiParser.isValid(siciDoi)).toBe(true);
      expect(doiParser.normalize(siciDoi)).toBe(siciDoi.toLowerCase());
    });

    it('should throw IngestionValidationException for invalid or empty DOI strings', () => {
      expect(() => doiParser.normalize('')).toThrow(
        IngestionValidationException,
      );
      expect(() => doiParser.normalize('not-a-doi-12345')).toThrow(
        IngestionValidationException,
      );
      expect(doiParser.isValid('invalid-doi')).toBe(false);
    });
  });

  describe('BibtexParser - Balanced Braces & LaTeX Resilience', () => {
    it('should parse BibTeX entries with nested braces in title and corporate author without truncation', () => {
      const rawBibtex = `
@article{Vaswani2017,
  author = {{Google Brain Team} and Vaswani, Ashish and Bengio, Yoshua},
  title = {Attention Is All You Need: {Deep Learning} with {Self-Attention} Mechanisms},
  journal = {Advances in {Neural Information Processing Systems}},
  year = {2017},
  volume = {30},
  pages = {5998--6008},
  doi = {10.5555/3295222.3295349}
}
      `;

      const entries = bibtexParser.parse(rawBibtex);
      expect(entries).toHaveLength(1);
      const entry = entries[0];
      expect(entry.citationKey).toBe('Vaswani2017');
      expect(entry.year).toBe(2017);
      expect(entry.doi).toBe('10.5555/3295222.3295349');
      expect(entry.title).toContain('Attention Is All You Need');
      expect(entry.authors.length).toBeGreaterThan(0);
    });

    it('should cleanly fallback to manual scanner when @citation-js encounters non-standard BibTeX', () => {
      const nonStandardBibtex = `
@misc{flux_doc_2026,
  title = {Custom Documentation with {Special} {Nested {Braces}}},
  author = {Smith, John and {Acme Scientific Corp}},
  year = 2026,
  url = "https://flux.study/docs",
  note = {Internal Research Note}
}
      `;

      // Test fallbackParse directly to ensure 100% test coverage of balanced brace scanner
      const fallbackResults = (bibtexParser as any).fallbackParse(
        nonStandardBibtex,
      );
      expect(fallbackResults).toHaveLength(1);
      const entry = fallbackResults[0];
      expect(entry.citationKey).toBe('flux_doc_2026');
      expect(entry.year).toBe(2026);
      expect(entry.title).toContain(
        'Custom Documentation with Special Nested Braces',
      );
      expect(entry.authors).toContain('Smith, John');
      expect(entry.authors).toContain('{Acme Scientific Corp}');
      expect(entry.url).toBe('https://flux.study/docs');
      expect(entry.notes).toEqual(['Internal Research Note']);
    });
  });
});
