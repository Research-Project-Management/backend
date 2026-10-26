import { Test, TestingModule } from '@nestjs/testing';
import { DoiParser } from '@/modules/library/ingestion/parsers/doi.parser';
import { BibtexParser } from '@/modules/library/ingestion/parsers/bibtex.parser';
import { XmlLegacyFormatsParser } from '@/modules/library/ingestion/parsers/xml-legacy-formats.parser';
import { IngestionValidationException } from '@/modules/library/ingestion/types/ingestion.errors';

describe('Library Ingestion Parsers (DoiParser, BibtexParser & XmlLegacyFormatsParser)', () => {
  let doiParser: DoiParser;
  let bibtexParser: BibtexParser;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [DoiParser, BibtexParser, XmlLegacyFormatsParser],
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
      expect(
        doiParser.normalize('https://www.nature.com/articles/nature12373'),
      ).toBe('10.1038/nature12373');
      expect(doiParser.normalize('https://zenodo.org/records/5554321')).toBe(
        '10.5281/zenodo.5554321',
      );
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

    it('should parse EndNote XML, MODS XML, Zotero RDF, Medline NBIB and Bibliographic CSV via XmlLegacyFormatsParser', () => {
      const parser = new XmlLegacyFormatsParser();
      expect(
        parser.parse(
          `<xml><records><record><ref-type name="Journal Article">17</ref-type><titles><title>EndNote Quantum Computing</title></titles><contributors><authors><author>Feynman, Richard</author></authors></contributors><dates><year>1982</year></dates><electronic-resource-num>10.1007/BF02650179</electronic-resource-num></record></records></xml>`,
          'ENDNOTE_XML',
        )[0]?.title,
      ).toBe('EndNote Quantum Computing');
      expect(
        parser.parse(
          `<modsCollection><mods><titleInfo><title>MODS Digital Libraries</title></titleInfo><originInfo><dateIssued>2000</dateIssued></originInfo></mods></modsCollection>`,
          'MODS',
        )[0]?.title,
      ).toBe('MODS Digital Libraries');
      expect(
        parser.parse(
          `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:bib="http://purl.org/net/biblio#" xmlns:dc="http://purl.org/dc/elements/1.1/"><bib:Article><dc:title>Zotero RDF Semantic Web</dc:title><dc:date>2001</dc:date></bib:Article></rdf:RDF>`,
          'ZOTERO_RDF',
        )[0]?.title,
      ).toBe('Zotero RDF Semantic Web');
      expect(
        parser.parse(
          `PMID- 31452104\nTI  - Deep learning in medicine\nFAU - Topol, Eric J\nDP  - 2019 Jan`,
          'MEDLINE',
        )[0]?.pmid,
      ).toBe('31452104');
      expect(
        parser.parse(
          `"Item Type","Publication Year","Author","Title"\n"journalArticle","2023","Hinton, Geoffrey","Forward-Forward Algorithm"`,
          'CSV',
        )[0]?.title,
      ).toBe('Forward-Forward Algorithm');
    });
  });
});
