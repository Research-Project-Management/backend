import { Test, TestingModule } from '@nestjs/testing';
import { DoiParser } from '@/modules/library/ingestion/parsers/bibtex.parser';
import { BibtexParser } from '@/modules/library/ingestion/parsers/bibtex.parser';
import { RisParser } from '@/modules/library/ingestion/parsers/ris.parser';
import { CslParser } from '@/modules/library/ingestion/parsers/csl.parser';
import { parseAcademicFeedXml } from '@/modules/library/ingestion/parsers/rss-atom-feed.parser';
import { XmlLegacyFormatsParser } from '@/modules/library/ingestion/parsers/xml-legacy-formats.parser';
import { HtmlMetaTagExtractor } from '@/modules/library/ingestion/services/html-meta-tag.extractor';
import { MetadataRoutingPolicy } from '@/modules/library/ingestion/policies/metadata.policy';
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
      expect(entry.authors).toContain('John Smith');
      expect(entry.authors).toContain('Acme Scientific Corp');
      expect(entry.url).toBe('https://flux.study/docs');
      expect(entry.notes).toEqual(['Internal Research Note']);
    });

    it('should concatenate # string literals in BibTeX fallback parser and preserve Windows drive paths in JabRef file field', () => {
      const concatBib = `
@article{concat_2026,
  title = "Part One: " # "Part Two",
  author = {Ada Lovelace},
  year = 2026,
  file = {:C\\:/Users/paper.pdf:PDF;Appendix:D:/docs/supp.pdf:PDF}
}
      `;
      const fallbackResults = (bibtexParser as any).fallbackParse(concatBib);
      expect(fallbackResults).toHaveLength(1);
      expect(fallbackResults[0].title).toBe('Part One: Part Two');
      expect(fallbackResults[0].authors).toEqual(['Ada Lovelace']);
      expect(fallbackResults[0].fileUrl).toBe('C:/Users/paper.pdf');
    });

    it('should parse EndNote/UNIX Refer format (%0, %T, %A, %D, %J, %R) via RisParser', () => {
      const risParser = new RisParser();
      const referText = [
        '%0 Journal Article',
        '%T Attention Is All You Need',
        '%A Vaswani, Ashish',
        '%A Shazeer, Noam',
        '%D 2017',
        '%J Advances in Neural Information Processing Systems',
        '%V 30',
        '%P 5998-6008',
        '%R 10.5555/3295222.3295349',
        '%K Transformers',
        '%K Deep Learning',
      ].join('\n');

      const entries = risParser.parse(referText);
      expect(entries).toHaveLength(1);
      expect(entries[0].title).toContain('Attention Is All You Need');
      expect(entries[0].year).toBe(2017);
      expect(entries[0].doi).toBe('10.5555/3295222.3295349');
      expect(entries[0].authors?.length).toBeGreaterThanOrEqual(2);
    });

    it('should extract object-based keywords in CslParser and handle self-closing <link/> in parseAcademicFeedXml', () => {
      const cslParser = new CslParser();
      const cslEntries = cslParser.parse([
        {
          type: 'article-journal',
          title: 'CSL Object Keywords Test',
          keyword: [{ name: 'Graph Neural Networks' }, { keyword: 'Message Passing' }],
        },
      ]);
      expect(cslEntries[0].keywords).toEqual([
        'Graph Neural Networks',
        'Message Passing',
      ]);

      const atomXml = `
        <feed xmlns="http://www.w3.org/2005/Atom">
          <title>arXiv Feed</title>
          <link href="https://arxiv.org/rss/cs.AI" rel="self" />
          <entry>
            <id>http://arxiv.org/abs/2401.12345v1</id>
            <title>Atom Self-Closing Link Entry</title>
            <link href="https://arxiv.org/abs/2401.12345" rel="alternate" />
            <published>2024-01-15T00:00:00Z</published>
          </entry>
        </feed>
      `;
      const feed = parseAcademicFeedXml(atomXml);
      expect(feed.entries).toHaveLength(1);
      expect(feed.entries[0].url).toBe('https://arxiv.org/abs/2401.12345');
    });

    it('should not extract citation_fulltext_html_url as pdfUrl unless it ends with .pdf and should block trailing-dot localhost SSRF', async () => {
      const extractor = new HtmlMetaTagExtractor();
      const meta = extractor.extractHtmlMetadata(
        `<html><head>
          <meta name="citation_title" content="HTML Landing Page Test" />
          <meta name="citation_fulltext_html_url" content="https://publisher.example.com/article/html" />
          <meta name="dc.identifier.uri" content="https://publisher.example.com/handle/12345" />
        </head></html>`,
        'https://publisher.example.com/article',
      );
      expect(meta?.pdfUrl).toBeUndefined();

      await expect(
        MetadataRoutingPolicy.assertSafeUrl('http://localhost./admin'),
      ).rejects.toThrow();
    });

    it('should parse EndNote XML, MODS XML, Zotero RDF, Medline NBIB and Bibliographic CSV via XmlLegacyFormatsParser', () => {
      const parser = new XmlLegacyFormatsParser();
      expect(
        parser.parse(
          `<xml><records><record><ref-type name="Journal Article">17</ref-type><titles><title>EndNote Quantum Computing &amp;amp; Physics &#x1D538;</title></titles><contributors><authors><author>Feynman, Richard</author></authors></contributors><dates><year>1982</year></dates><electronic-resource-num>10.1007/BF02650179</electronic-resource-num></record></records></xml>`,
          'ENDNOTE_XML',
        )[0]?.title,
      ).toBe('EndNote Quantum Computing &amp; Physics 𝔸');
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
