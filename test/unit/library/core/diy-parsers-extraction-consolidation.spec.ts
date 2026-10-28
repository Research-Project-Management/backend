import { PDFDocument } from 'pdf-lib';
import { PdfProvider } from '@/modules/library/extraction/providers/pdf.provider';
import { PdfTextMetadataExtractor } from '@/modules/library/extraction/providers/pdf-text-metadata.extractor';
import { MeXtractExtractor } from '@/modules/library/extraction/extractors/mextract.extractor';
import { XmpParser } from '@/modules/library/extraction/extractors/xmp.parser';
import {
  XmlLegacyFormatsParser,
  extractBalancedXmlTag,
  extractFirstXmlBlock,
} from '@/modules/library/ingestion/parsers/xml-legacy-formats.parser';
import { ArxivProvider } from '@/modules/library/ingestion/providers/arxiv.provider';
import {
  convertAcademicHtmlToMarkdown,
  stripNoteHtml,
  buildTipTapDocFromText,
  normalizeAcademicTitle,
  extractAuthorTokens,
} from '@/modules/library/core';
import { getEffectiveItemField } from '@/modules/library/ingestion/services/duplicate-detector.service';
import { ReferenceMatcherService } from '@/modules/library/extraction/services/reference-matcher.service';
import { evalAnyFieldCondition } from '@/modules/library/catalog/domain/condition-operators.strategy';
import { TextSearchSpecification } from '@/modules/library/search/domain/item-specifications';

describe('DIY Parsers, Extraction, Academic Domain & Citation Consolidation (SH2-01..04)', () => {
  describe('SH2-01: PdfProvider, PdfTextMetadataExtractor & MeXtractExtractor', () => {
    it('extracts PDF Info metadata via pdf-lib and handles UTF-16BE BOM & nested parentheses in fallback', async () => {
      const pdfProvider = new PdfProvider();

      // 1. Real pdf-lib document with Title, Author, Subject, Keywords, CreationDate
      const doc = await PDFDocument.create();
      doc.setTitle('Deep Learning (Phase I): A Unified Framework');
      doc.setAuthor('John von Neumann; Alan M. Turing');
      doc.setSubject(
        'We present a rigorous mathematical formulation of neural computation and stochastic approximation.',
      );
      doc.setKeywords(['Deep Learning, Stochastic Optimization, Transformers']);
      doc.setCreationDate(new Date('2024-06-15T00:00:00.000Z'));
      doc.addPage([600, 800]);
      const pdfBytes = await doc.save();
      const pdfBuffer = Buffer.from(pdfBytes);

      const asyncMeta =
        await pdfProvider.extractMetadataFromBufferAsync(pdfBuffer);
      expect(asyncMeta.title).toBe(
        'Deep Learning (Phase I): A Unified Framework',
      );
      expect(asyncMeta.authors).toEqual(['John von Neumann', 'Alan M. Turing']);
      expect(asyncMeta.abstract).toContain('rigorous mathematical formulation');
      expect(asyncMeta.keywords).toEqual(
        expect.arrayContaining(['Deep Learning', 'Stochastic Optimization']),
      );
      expect(asyncMeta.year).toBe(2024);

      // 2. Fallback buffer with escaped parentheses and UTF-16BE BOM (þÿ)
      const utf16HeaderBuf = Buffer.from(
        '%PDF-1.6\n/Title (þÿ\x00A\x00I\x00 \x00(\x00P\x00a\x00r\x00t\x00 \x001\x00))\n/Author (John \\(von\\) Neumann)\n/CreationDate (D:20230510)\n',
        'latin1',
      );
      const syncMeta = pdfProvider.extractMetadataFromBuffer(utf16HeaderBuf);
      expect(syncMeta.title).toBe('AI (Part 1)');
      expect(syncMeta.authors).toEqual(['John (von) Neumann']);
      expect(syncMeta.year).toBe(2023);
    });

    it('preserves single-letter words like "A I in Medicine" and "Phase I A Study" while repairing >=3 single-letter kerning runs', () => {
      const extractor = new PdfTextMetadataExtractor();

      const aiMedicineText = [
        'A I in Medicine: Phase I A Study of Clinical Decision Support',
        'John von Neumann, Nguyễn Văn An',
        'Abstract: Clinical decision support systems require calibrated uncertainty estimation.',
      ].join('\n');

      const meta1 = extractor.extractMetadataFromText(aiMedicineText);
      expect(meta1.title).toBe(
        'A I in Medicine: Phase I A Study of Clinical Decision Support',
      );
      expect(meta1.authors).toEqual(['John von Neumann', 'Nguyễn Văn An']);

      const spacedKerningText = [
        'D E E P L E A R N I N G for Molecular Property Prediction',
        ' Pieter van der Berg , Maria Del Carmen ',
        'Abstract: Molecular graph representations enable accurate property prediction across benchmarks.',
      ].join('\n');

      const meta2 = extractor.extractMetadataFromText(spacedKerningText);
      expect(meta2.title).toBe(
        'DEEPLEARNING for Molecular Property Prediction',
      );
      expect(meta2.authors).toEqual([
        'Pieter van der Berg',
        'Maria Del Carmen',
      ]);
    });

    it('sets MeXtractExtractor inProcessStructureParse confidence to 0.72 and delegates author splitting to splitAuthorString', async () => {
      const text = [
        'Autonomous Multi-Agent Planning Under Dynamic Operational Latencies',
        'John von Neumann, Pieter van der Berg, and Nguyễn Văn An',
        'Abstract: Coordinating autonomous agents in distributed environments requires robust planning against delays.',
        '1. Introduction',
      ].join('\n');

      const res = await MeXtractExtractor.extract(text);
      expect(res).not.toBeNull();
      expect(res?.engine).toBe('MEXTRACT_HEURISTIC_SLM');
      expect(res?.confidence).toBe(0.72);
      expect(res?.metadata.authors).toEqual([
        'John von Neumann',
        'Pieter van der Berg',
        'Nguyễn Văn An',
      ]);
    });
  });

  describe('SH2-02: XML Legacy Formats, MODS Nested <relatedItem>, XMP Attribute RDF & ArxivProvider', () => {
    it('extracts EndNote <titles> block without <related-urls> title shadowing and parses nested MODS <relatedItem>', () => {
      const parser = new XmlLegacyFormatsParser();

      const endnoteXml = `
        <xml><records><record>
          <ref-type name="Journal Article">17</ref-type>
          <contributors><authors><author>Vaswani, Ashish</author></authors></contributors>
          <related-urls><url><title>Supplementary PDF Link Title</title></url></related-urls>
          <titles>
            <title>Attention Is All You Need &amp; More</title>
            <secondary-title>Advances in Neural Information Processing Systems</secondary-title>
          </titles>
          <dates><year>2017</year></dates>
        </record></records></xml>
      `;
      const endnoteItems = parser.parseEndnoteXml(endnoteXml);
      expect(endnoteItems).toHaveLength(1);
      expect(endnoteItems[0].title).toBe('Attention Is All You Need & More');
      expect(endnoteItems[0].publicationTitle).toBe(
        'Advances in Neural Information Processing Systems',
      );
      expect(endnoteItems[0].year).toBe(2017);

      const modsXml = `
        <modsCollection>
          <mods>
            <titleInfo>
              <title>Main Article Title</title>
              <subTitle>A Detailed Investigation</subTitle>
            </titleInfo>
            <name type="personal">
              <namePart type="given">Ada</namePart>
              <namePart type="family">Lovelace</namePart>
              <role><roleTerm>author</roleTerm></role>
            </name>
            <relatedItem type="host">
              <relatedItem type="series">
                <titleInfo><title>Lecture Notes in Computer Science</title></titleInfo>
              </relatedItem>
              <titleInfo>
                <title>Journal of Symbolic Computation</title>
              </titleInfo>
              <originInfo><dateIssued>2023-09-01</dateIssued></originInfo>
              <part>
                <detail type="volume"><number>45</number></detail>
                <detail type="issue"><number>2</number></detail>
                <extent unit="pages"><start>101</start><end>128</end></extent>
              </part>
            </relatedItem>
          </mods>
        </modsCollection>
      `;

      const balanced = extractBalancedXmlTag(modsXml, 'relatedItem', (attrs) =>
        attrs.includes('host'),
      );
      expect(balanced?.innerXml).toContain('Journal of Symbolic Computation');
      expect(extractFirstXmlBlock(endnoteXml, 'titles')).toContain(
        'Attention Is All You Need',
      );

      const modsItems = parser.parseModsXml(modsXml);
      expect(modsItems).toHaveLength(1);
      expect(modsItems[0].title).toBe(
        'Main Article Title: A Detailed Investigation',
      );
      expect(modsItems[0].publicationTitle).toBe(
        'Journal of Symbolic Computation',
      );
      expect(modsItems[0].volume).toBe('45');
      expect(modsItems[0].issue).toBe('2');
      expect(modsItems[0].pages).toBe('101-128');
      expect(modsItems[0].year).toBe(2023);
    });

    it('parses RDF attribute-form properties including prism:startingPage and prism:endingPage in XmpParser', () => {
      const xmpPacket = `
        <x:xmpmeta xmlns:x="adobe:ns:meta/">
          <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <rdf:Description
              dc:title="Attribute Form &mdash; XMP Paper"
              prism:doi="doi:10.1038/s41586-024-01234-5"
              prism:publicationName="Nature"
              prism:volume="628"
              prism:issue="8007"
              prism:startingPage="310"
              prism:endingPage="318"
              prism:publicationDate="2024-04-11" />
          </rdf:RDF>
        </x:xmpmeta>
      `;
      const parsed = XmpParser.parse(
        Buffer.from(`%PDF-1.7\n${xmpPacket}\n%%EOF`, 'utf-8'),
      );
      expect(parsed).not.toBeNull();
      expect(parsed?.title).toBe('Attribute Form — XMP Paper');
      expect(parsed?.doi).toBe('10.1038/s41586-024-01234-5');
      expect(parsed?.journal).toBe('Nature');
      expect(parsed?.volume).toBe('628');
      expect(parsed?.issue).toBe('8007');
      expect(parsed?.startingPage).toBe('310');
      expect(parsed?.endingPage).toBe('318');
      expect(parsed?.pages).toBe('310-318');
    });

    it('uses decodeHtmlEntities and normalizeDoi / normalizeArxivId in ArxivProvider.parseAtomXml', () => {
      const provider = new ArxivProvider();
      const atomXml = `
        <feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
          <entry>
            <title>Quantum &amp; Classical Complexity&#x2014;A Synthesis</title>
            <author><name>Scott &amp; Aaronson</name></author>
            <published>2024-03-15T12:00:00Z</published>
            <summary>We study quantum complexity classes.</summary>
            <arxiv:primary_category term="quant-ph" />
            <arxiv:doi>https://doi.org/10.1103/PhysRevX.14.011001</arxiv:doi>
          </entry>
        </feed>
      `;
      const result = (
        provider as unknown as {
          parseAtomXml: (xml: string, id: string) => {
            metadata: {
              title?: string;
              arxivId?: string;
              doi?: string;
              extraFields?: { publishedDoi?: string };
            };
          } | null;
        }
      ).parseAtomXml(atomXml, 'arXiv:2403.12345v2');

      expect(result).not.toBeNull();
      expect(result?.metadata.title).toBe(
        'Quantum & Classical Complexity—A Synthesis',
      );
      expect(result?.metadata.arxivId).toBe('2403.12345v2');
      expect(result?.metadata.doi).toBe('10.48550/arXiv.2403.12345');
      expect(result?.metadata.extraFields?.publishedDoi).toBe(
        '10.1103/physrevx.14.011001',
      );
    });
  });

  describe('SH2-03: convertAcademicHtmlToMarkdown, stripNoteHtml & buildTipTapDocFromText', () => {
    it('prefixes every line of multi-line blockquotes, numbers <ol> items, and decodes named/numeric entities', () => {
      const html = `
        <h2>Key Findings &mdash; Phase &#x394;</h2>
        <blockquote><p>First quoted line</p><p>Second quoted line</p></blockquote>
        <ol>
          <li>First ordered step</li>
          <li>Second ordered step</li>
        </ol>
        <ul>
          <li>Bullet item &apos;alpha&apos;</li>
        </ul>
      `;
      const md = convertAcademicHtmlToMarkdown(html);
      expect(md).toContain('## Key Findings — Phase Δ');
      expect(md).toContain('> First quoted line\n> Second quoted line');
      expect(md).toContain('1. First ordered step\n2. Second ordered step');
      expect(md).toContain("- Bullet item 'alpha'");
    });

    it('decodes named and numeric entities in stripNoteHtml and parses Markdown nodes in buildTipTapDocFromText', () => {
      expect(
        stripNoteHtml(
          '<p>Author&#39;s Note &mdash; Section &apos;A&apos; &#x2022; Item</p>',
        ),
      ).toBe("Author's Note — Section 'A' • Item");

      const markdown = [
        '## Methodology Overview',
        '',
        '- First bullet',
        '- Second bullet',
        '',
        '1. Step one',
        '2. Step two',
        '',
        '> Quoted observation',
        '',
        'Plain paragraph with **bold**, *italic*, and `code` inline.',
      ].join('\n');

      const doc = buildTipTapDocFromText(markdown) as {
        type: string;
        content: Array<Record<string, unknown>>;
      };
      expect(doc.type).toBe('doc');
      expect(doc.content[0]).toEqual({
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: 'Methodology Overview' }],
      });
      expect(doc.content[1]).toMatchObject({
        type: 'bulletList',
      });
      expect(doc.content[2]).toMatchObject({
        type: 'orderedList',
      });
      expect(doc.content[3]).toMatchObject({
        type: 'blockquote',
      });
      expect(doc.content[4]).toEqual({
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Plain paragraph with ' },
          { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
          { type: 'text', text: ', ' },
          { type: 'text', text: 'italic', marks: [{ type: 'italic' }] },
          { type: 'text', text: ', and ' },
          { type: 'text', text: 'code', marks: [{ type: 'code' }] },
          { type: 'text', text: ' inline.' },
        ],
      });
    });
  });

  describe('SH2-04: Cross-Module Consolidation & Removal of item-1 Backdoor', () => {
    it('resolves coupled aliases for any item ID without hardcoded item-1 check', () => {
      const arbitraryItem = {
        id: 'arbitrary-uuid-999',
        publicationTitle: 'Any Journal Name',
        year: 2022,
        metadata: {},
      };
      expect(getEffectiveItemField(arbitraryItem, 'proceedingsTitle')).toBe(
        'Any Journal Name',
      );
      expect(getEffectiveItemField(arbitraryItem, 'date')).toBe(2022);
      expect(
        getEffectiveItemField(arbitraryItem, 'proceedingsTitle', undefined, {
          excludeGenericsFromSpecificTarget: true,
        }),
      ).toBeUndefined();
    });

    it('folds ligatures in normalizeAcademicTitle and preserves Unicode in ReferenceMatcherService.normalizeTitleKey', () => {
      expect(
        normalizeAcademicTitle('Große Encyclopædia of Œuvre, Ørsted & Łukasiewicz'),
      ).toBe('grosse encyclopaedia of oeuvre orsted lukasiewicz');

      const vnKey = ReferenceMatcherService.normalizeTitleKey(
        'Ứng dụng Trí tuệ Nhân tạo trong Y học',
      );
      expect(vnKey).toBe('ungdungtrituenhantaotrongyhoc');

      const greekCjkKey = ReferenceMatcherService.normalizeTitleKey(
        '深度学习与 α-β 剪枝算法',
      );
      expect(greekCjkKey).toBe('深度学习与αβ剪枝算法');
    });

    it('recognizes organizational authors via isInstitutionName during file renaming', () => {
      const tokens = extractAuthorTokens([
        {
          fullName: 'Mayo Clinic Health System',
          creatorType: 'author',
          fieldMode: 0,
        },
      ]);
      expect(tokens.firstAuthor).toBe('Mayo Clinic Health System');
    });

    it('unifies anyField search coverage between evalAnyFieldCondition and TextSearchSpecification', () => {
      const smartCollectionWhere = evalAnyFieldCondition('contains', 'neural');
      const smartJson = JSON.stringify(smartCollectionWhere);
      expect(smartJson).toContain('"annotations"');
      expect(smartJson).toContain('"quoteText"');
      expect(smartJson).toContain('"comment"');

      const textSpec = new TextSearchSpecification('10.1038/nature14539');
      const specWhereJson = JSON.stringify(textSpec.toPrismaWhere());
      expect(specWhereJson).toContain('"filename"');
      expect(specWhereJson).toContain('"identifiers"');

      expect(
        textSpec.isSatisfiedBy({
          title: 'Unrelated Title',
          attachments: [{ deletedAt: null, filename: '10.1038/nature14539.pdf' }],
        }),
      ).toBe(true);

      expect(
        textSpec.isSatisfiedBy({
          title: 'Unrelated Title',
          identifiers: [{ type: 'custom', value: '10.1038/nature14539' }],
        }),
      ).toBe(true);
    });
  });
});
