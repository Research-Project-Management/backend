import { BibliographyFormatRegistry } from '@/modules/library/ingestion/parsers/bibliography-format.registry';
import {
  BibtexParser,
  DoiParser,
} from '@/modules/library/ingestion/parsers/bibtex.parser';
import { RisParser } from '@/modules/library/ingestion/parsers/ris.parser';
import { CslParser } from '@/modules/library/ingestion/parsers/csl.parser';
import { XmlLegacyFormatsParser } from '@/modules/library/ingestion/parsers/xml-legacy-formats.parser';
import { parseFeedXml } from '@/modules/library/ingestion/parsers/rss-atom-feed.parser';
import { HtmlMetaTagExtractor } from '@/modules/library/ingestion/parsers/html-meta-tag.extractor';
import { MetadataRoutingPolicy } from '@/modules/library/ingestion/domain/metadata.policy';
import { NormalizationPolicy } from '@/modules/library/ingestion/domain/normalization.policy';
import { IngestionValidationException } from '@/modules/library/ingestion/types/metadata.types';

describe('Library Ingestion Parsers & Normalization Policy', () => {
  const doiParser = new DoiParser();
  const bibtexParser = new BibtexParser();
  const risParser = new RisParser();
  const cslParser = new CslParser();
  const xmlParser = new XmlLegacyFormatsParser();
  const registry = new BibliographyFormatRegistry(
    bibtexParser,
    risParser,
    cslParser,
    xmlParser,
  );
  const normalizer = new NormalizationPolicy();

  describe('DoiParser', () => {
    it('normalizes DOIs, derives DOIs from publisher URLs, supports SICI angle brackets, and rejects invalid inputs', () => {
      expect(
        doiParser.normalize('https://doi.org/10.1038/s41586-020-2649-2'),
      ).toBe('10.1038/s41586-020-2649-2');
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

      const sici =
        '10.1002/1097-0142(19901001)66:7<1411::AID-CNCR2820660702>3.0.CO;2-9';
      expect(doiParser.isValid(sici)).toBe(true);
      expect(doiParser.normalize(sici)).toBe(sici.toLowerCase());

      expect(() => doiParser.normalize('')).toThrow(
        IngestionValidationException,
      );
      expect(() => doiParser.normalize('not-a-doi')).toThrow(
        IngestionValidationException,
      );
    });
  });

  describe('BibliographyFormatRegistry & Multi-Record Zero-Bleed Parsing', () => {
    it('parses BibTeX with @STRING macros, LaTeX accents, corporate braces, # fallback concatenation, and 5-record zero-bleed batches', async () => {
      const messyBibtex = `
        @STRING{cvpr = "Proceedings of the IEEE/CVF Conference on Computer Vision and Pattern Recognition (CVPR)"}
        @inproceedings{schrodinger2024quantum,
          author = {Schr{\\"o}dinger, Erwin and {World Health Organization} and Garc{\\'i}a-M{\\'a}rquez, Gabriel},
          title = {{Deep Learning for {COVID-19} Chest X-Ray Triage}},
          booktitle = cvpr, year = {2024}, pages = {1024--1035},
          doi = {https://doi.org/10.1109/CVPR52733.2024.00102}
        }
      `;
      expect(registry.detectRecordFormat(messyBibtex)).toBe('BIBTEX');
      const env = await registry.parseEnvelopes(messyBibtex);
      expect(env[0].rawMetadata).toMatchObject({
        year: 2024,
        pages: '1024-1035',
      });
      const authors = env[0].rawMetadata.authors as string[];
      expect(authors.some((a) => a.includes('Schrödinger'))).toBe(true);
      expect(authors.some((a) => a.includes('World Health Organization'))).toBe(
        true,
      );

      const fallbackEntries = (
        bibtexParser as unknown as {
          fallbackParse: (raw: string) => Array<Record<string, unknown>>;
        }
      ).fallbackParse(`
        @article{concat_2026,
          title = "Part One: " # "Part Two",
          author = {Ada Lovelace},
          year = 2026,
          file = {:C\\:/Users/paper.pdf:PDF;Appendix:D:/docs/supp.pdf:PDF}
        }
      `);
      expect(fallbackEntries[0]).toMatchObject({
        title: 'Part One: Part Two',
        fileUrl: 'C:/Users/paper.pdf',
      });

      const batchRecords = bibtexParser.parse(`
        @article{rec1_2020, title={First Quantum Paper}, author={Shor, Peter}, journal={PRL}, year={2020}, doi={10.1103/PhysRevLett.124.010501}, keywords={quantum, codes}}
        @inproceedings{rec2_2021, title={Second Compiler Paper}, author={Lattner, Chris}, booktitle={PLDI 2021}, editor={Torczon, Linda}, year={2021}}
        @incollection{rec3_2022, title={Third Chapter}, author={Lamport, Leslie}, booktitle={Distributed Systems}, year={2022}, isbn={978-1-4503-9999-9}}
        @phdthesis{rec4_2023, title={Fourth Thesis}, author={Ringer, Talia}, school={University of Washington}, year={2023}}
        @misc{rec5_2024, title={Fifth Preprint}, author={Fedus, William}, eprint={2403.54321}, archivePrefix={arXiv}, year={2024}}
      `);
      expect(batchRecords).toHaveLength(5);
      expect(batchRecords[0].itemType).toBe('journalArticle');
      expect(batchRecords[1].itemType).toBe('conferencePaper');
      expect(batchRecords[1].doi).toBeUndefined();
      expect(batchRecords[1].editors).toEqual(['Linda Torczon']);
      expect(batchRecords[2].itemType).toBe('bookSection');
      expect(batchRecords[2].editors).toBeUndefined();
      expect(batchRecords[3].itemType).toBe('thesis');
      expect(batchRecords[3].isbn).toBeUndefined();
      expect(batchRecords[4].itemType).toBe('preprint');
      expect(batchRecords[4].arxivId).toBe('2403.54321');
    });

    it('parses RIS multi-record batches (JOUR/CONF/THES/RPRT) and EndNote/UNIX Refer (%0/%T) with zero state bleed', () => {
      const risBatch = [
        'TY  - JOUR',
        'TI  - First RIS Journal Article',
        'AU  - Curien, Pierre-Louis',
        'JO  - JFP',
        'PY  - 2020/03/15/',
        'SP  - 1',
        'EP  - 42',
        'DO  - 10.1017/S0956796820000015',
        'KW  - lambda calculus',
        'ER  - ',
        'TY  - CONF',
        'TI  - Second RIS Conference Paper',
        'AU  - Wadler, Philip',
        'A2  - Harper, Robert',
        'T2  - ICFP 2021',
        'PY  - 2021',
        'ER  - ',
        'TY  - THES',
        'TI  - Third RIS Doctoral Thesis',
        'AU  - Girard, Jean-Yves',
        'PB  - Universite Paris VII',
        'PY  - 1972',
        'ER  - ',
        'TY  - RPRT',
        'TI  - Fourth RIS Technical Report',
        'AU  - Milner, Robin',
        'IS  - ECS-LFCS-88-46',
        'PY  - 1988',
        'ER  - ',
      ].join('\n');

      const records = risParser.parse(risBatch);
      expect(records).toHaveLength(4);
      expect(records[0]).toMatchObject({
        itemType: 'journalArticle',
        pages: '1-42',
        doi: '10.1017/s0956796820000015',
      });
      expect(records[1].itemType).toBe('conferencePaper');
      expect(records[1].doi).toBeUndefined();
      expect(records[1].editors).toEqual(['Robert Harper']);
      expect(records[2].itemType).toBe('thesis');
      expect(records[2].university).toBe('Universite Paris VII');
      expect(records[3].itemType).toBe('report');
      expect(records[3].reportNumber).toBe('ECS-LFCS-88-46');

      const referEntries = risParser.parse(
        [
          '%0 Journal Article',
          '%T Attention Is All You Need',
          '%A Vaswani, Ashish',
          '%D 2017',
          '%R 10.5555/3295222.3295349',
        ].join('\n'),
      );
      expect(referEntries).toHaveLength(1);
      expect(referEntries[0].doi).toBe('10.5555/3295222.3295349');
    });

    it('parses PubMed NBIB, EndNote XML, MODS XML, Zotero RDF, CSV, CSL-JSON, and Atom/RDF feeds accurately', () => {
      const nbib = xmlParser.parseMedlineNbib(
        [
          'PMID- 31000001',
          'TI  - First PubMed Trial',
          'FAU - Kariko, Katalin',
          'DP  - 2021 Apr',
          'LID - 10.1038/s41591-021-00001-1 [doi]',
          'PMC - PMC7000001',
          '',
          'PMID- 31000002',
          'TI  - Second PubMed Study Without PMC',
          'FAU - Fauci, Anthony S',
          'DP  - 2022 Nov',
        ].join('\n'),
      );
      expect(nbib).toHaveLength(2);
      expect(nbib[0]).toMatchObject({
        pmid: '31000001',
        pmcid: 'PMC7000001',
        doi: '10.1038/s41591-021-00001-1',
      });
      expect(nbib[1].pmcid).toBeUndefined();

      const endnote = xmlParser.parseEndnoteXml(`<?xml version="1.0"?>
        <xml><records>
          <record><ref-type name="Book Section">5</ref-type><titles><title>EndNote Chapter &amp;amp; &#x1D538;</title><secondary-title>Methods in Enzymology</secondary-title></titles>
            <contributors><authors><author>Zhang, Feng</author></authors><secondary-authors><author>Church, George M.</author></secondary-authors></contributors>
            <dates><year>2014</year></dates><isbn>978-0-12-800202-5</isbn></record>
        </records></xml>`);
      expect(endnote[0]).toMatchObject({
        itemType: 'bookSection',
        title: 'EndNote Chapter &amp; 𝔸',
        bookTitle: 'Methods in Enzymology',
      });
      expect(
        endnote[0].creators?.map(
          (c) => `${c.creatorType}:${c.firstName} ${c.lastName}`,
        ),
      ).toEqual(['author:Feng Zhang', 'editor:George M. Church']);

      expect(
        xmlParser.parse(
          `<modsCollection><mods><titleInfo><title>MODS Digital Libraries</title></titleInfo><originInfo><dateIssued>2000</dateIssued></originInfo></mods></modsCollection>`,
          'MODS',
        )[0]?.title,
      ).toBe('MODS Digital Libraries');

      expect(
        xmlParser.parse(
          `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:bib="http://purl.org/net/biblio#" xmlns:dc="http://purl.org/dc/elements/1.1/"><bib:Article><dc:title>Zotero RDF Semantic Web</dc:title><dc:date>2001</dc:date></bib:Article></rdf:RDF>`,
          'ZOTERO_RDF',
        )[0]?.title,
      ).toBe('Zotero RDF Semantic Web');

      const csv = xmlParser.parseCsvBibliography(
        [
          'Item Type,Title,Author,Publication Year,DOI,ISBN',
          'journalArticle,"CSV Paper One","Hinton, Geoffrey; LeCun, Yann",2015,10.1038/nature14539,',
          'book,"CSV Book Two","Goodfellow, Ian",2016,,978-0262035613',
        ].join('\n'),
      );
      expect(csv).toHaveLength(2);
      expect(csv[0].doi).toBe('10.1038/nature14539');
      expect(csv[1].isbn).toBe('9780262035613');

      const cslParsed = cslParser.parse([
        {
          type: 'article-journal',
          title: 'Very Deep Convolutional Networks',
          note: 'PMID: 12345678\narXiv: 1409.1556 [cs.CV]\nOriginal Date: 2014',
          annote: '<p>Note paragraph.</p>',
          keyword: [{ name: 'Graph Neural Networks' }, { keyword: 'cs.CV' }],
        },
      ]);
      expect(cslParsed[0]).toMatchObject({
        pmid: '12345678',
        arxivId: '1409.1556',
        extra: 'Original Date: 2014',
        notes: ['<p>Note paragraph.</p>'],
      });
      expect(cslParsed[0].tags).toContain(
        'Computer Science - Computer Vision and Pattern Recognition',
      );

      const rdfFeed = parseFeedXml(`<?xml version="1.0" encoding="UTF-8"?>
        <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:prism="http://prismstandard.org/namespaces/basic/2.0/">
          <channel><title>cs.CL updates on arXiv.org</title></channel>
          <item rdf:about="http://arxiv.org/abs/2405.12345">
            <title>Scaling Laws (arXiv:2405.12345v1 [cs.CL])</title>
            <link>http://arxiv.org/abs/2405.12345</link>
            <dc:creator>Jane Doe, John Smith</dc:creator>
            <prism:doi>10.48550/arXiv.2405.12345</prism:doi>
          </item>
        </rdf:RDF>`);
      expect(rdfFeed.entries[0]).toMatchObject({
        arxivId: '2405.12345',
        doi: '10.48550/arXiv.2405.12345',
      });
    });

    it('guards non-PDF HTML meta URLs, blocks trailing-dot localhost SSRF, and normalizes CrossRef types & HTML notes', async () => {
      const htmlExtractor = new HtmlMetaTagExtractor();
      const htmlMeta = htmlExtractor.extractHtmlMetadata(
        `<html><head>
          <meta name="citation_title" content="HTML Landing Page Test" />
          <meta name="citation_fulltext_html_url" content="https://publisher.example.com/article/html" />
        </head></html>`,
        'https://publisher.example.com/article',
      );
      expect(htmlMeta?.pdfUrl).toBeUndefined();

      await expect(
        MetadataRoutingPolicy.assertSafeUrl('http://localhost./admin'),
      ).rejects.toThrow();

      expect(
        normalizer.normalize({
          title: 'BERT',
          itemType: 'proceedings-article',
          doi: '10.18653/v1/N19-1423',
        }),
      ).toMatchObject({
        itemType: 'conferencePaper',
        doi: '10.18653/v1/n19-1423',
      });

      const normalizedNotes = normalizer.normalize({
        title: 'Test Note Formatting',
        notes: [
          '<p>First paragraph.</p><p>Second with <strong>bold</strong>.</p>',
          { content: 'Comment: 14 pages', source: 'arXiv' },
          { content: 'Comment: 14 pages', source: 'arXiv' },
        ],
      });
      expect(normalizedNotes.notes).toEqual([
        { content: 'First paragraph.\n\nSecond with **bold**.' },
        { content: 'Comment: 14 pages', source: 'arXiv' },
      ]);
    });
  });
});
