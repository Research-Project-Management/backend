import { extractText, getDocumentProxy, getMeta } from 'unpdf';
import {
  XmpParser,
  extractPdfBibliographyReferences,
  splitCitationSentences,
} from '@/modules/library/extraction/providers/pdf-outline.extractor';
import { MetadataQualityGate } from '@/modules/library/extraction/domain/attachments.domain';
import { LayoutExtractor } from '@/modules/library/extraction/providers/layout.extractor';
import { PdfMetadataExtractor } from '@/modules/library/extraction/providers/pdf-metadata.extractor';
import { PdfProvider } from '@/modules/library/extraction/providers/pdf.provider';
import { PdfTextMetadataExtractor } from '@/modules/library/extraction/providers/pdf-text.extractor';

jest.mock('unpdf', () => ({
  extractText: jest.fn(),
  getDocumentProxy: jest.fn(),
  getMeta: jest.fn(),
}));

describe('PDF Metadata, Layout, Provider & Reference Extraction', () => {
  const mockedExtractText = extractText as jest.Mock;
  const mockedGetDocumentProxy = getDocumentProxy as jest.Mock;
  const mockedGetMeta = getMeta as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.PDF_MAX_INDEX_PAGES;
  });

  describe('XmpParser & MetadataQualityGate', () => {
    it('extracts Dublin Core/PRISM XML, scans >64KB trailer packets, and decodes RDF attributes & entities safely', () => {
      const xmlPacket = `
        <x:xmpmeta xmlns:x="adobe:ns:meta/">
          <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"
                             xmlns:prism="http://prismstandard.org/namespaces/basic/2.0/"
                             prism:volume="30">
              <prism:doi>10.1038/s41586-020-2649-2</prism:doi>
              <dc:title><rdf:Alt><rdf:li xml:lang="x-default">Attention Is All You Need &#8211; &amp;amp; Transformers</rdf:li></rdf:Alt></dc:title>
              <dc:creator><rdf:Seq><rdf:li>Ashish Vaswani</rdf:li><rdf:li>Noam Shazeer</rdf:li></rdf:Seq></dc:creator>
              <prism:publicationDate>2017-06-12</prism:publicationDate>
              <prism:publicationName>Advances in Neural Information Processing Systems</prism:publicationName>
              <dc:subject><rdf:Bag><rdf:li>Deep Learning</rdf:li></rdf:Bag></dc:subject>
            </rdf:Description>
          </rdf:RDF>
        </x:xmpmeta>
      `;
      const parsed = XmpParser.parse(
        Buffer.concat([
          Buffer.from('%PDF-1.7\n'),
          Buffer.alloc(70_000, 0x20),
          Buffer.from(xmlPacket, 'utf-8'),
          Buffer.from('\n%%EOF'),
        ]),
      );

      expect(parsed).toMatchObject({
        doi: '10.1038/s41586-020-2649-2',
        title: 'Attention Is All You Need – &amp; Transformers',
        authors: ['Ashish Vaswani', 'Noam Shazeer'],
        year: 2017,
        volume: '30',
        journal: 'Advances in Neural Information Processing Systems',
        keywords: ['Deep Learning'],
      });
      expect(XmpParser.parse(Buffer.from('%PDF-1.4 no xmp'))).toBeNull();
    });

    it('enforces self-sufficiency boundary (score >= 0.85) and rejects bogus titles, placeholder authors, and invalid ISBN checksums', () => {
      expect(
        MetadataQualityGate.evaluate({
          title: 'Deep Residual Learning for Image Recognition',
          authors: ['Kaiming He', 'Xiangyu Zhang'],
          arxivId: '1512.03385',
          year: 2015,
        }).isSelfSufficient,
      ).toBe(true);

      const badEval = MetadataQualityGate.evaluate({
        title: 'Journal Pre-proof',
        authors: ['University of California, Berkeley', 'Administrator'],
        isbn: '9780262033849',
        year: 2024,
      });
      expect(badEval.isSelfSufficient).toBe(false);
      expect(badEval.breakdown.titleScore).toBe(0);
      expect(badEval.breakdown.identifierScore).toBe(0);
    });
  });

  describe('LayoutExtractor & PdfMetadataExtractor Multi-Tier Cascade', () => {
    it('rejects bogus PDF titles, filters rotated watermarks/noise headers, and strips repeated running headers/footers', async () => {
      expect(
        PdfMetadataExtractor.isBogusTitle('Microsoft Word - Document1.docx'),
      ).toBe(true);
      expect(
        PdfMetadataExtractor.isBogusTitle('10.1038/s41586-021-03819-2'),
      ).toBe(true);
      expect(
        PdfMetadataExtractor.isBogusTitle(
          'Scaling Laws for Neural Language Models',
        ),
      ).toBe(false);

      mockedGetDocumentProxy.mockResolvedValueOnce({
        numPages: 1,
        getPage: jest.fn().mockResolvedValue({
          cleanup: jest.fn(),
          getTextContent: jest.fn().mockResolvedValue({
            items: [
              {
                str: 'arXiv:2401.12345v1 [cs.LG] 10 Jan 2024',
                transform: [0, 28, -28, 0, 15, 400],
              },
              {
                str: 'Journal Pre-proof',
                transform: [24, 0, 0, 24, 50, 760],
              },
              {
                str: 'Robust Graph Representation Learning',
                transform: [18, 0, 0, 18, 50, 700],
              },
              {
                str: 'Elena Rostova, Marcus Vance',
                transform: [12, 0, 0, 12, 50, 660],
              },
              {
                str: 'In this paper we propose a novel graph representation learning framework that is designed to handle noisy topologies and dynamic edge perturbations across benchmarks.',
                transform: [10, 0, 0, 10, 50, 620],
              },
              {
                str: 'Fake Author After Prose',
                transform: [11, 0, 0, 11, 50, 600],
              },
            ],
          }),
        }),
      });

      const layout = await LayoutExtractor.extract(
        Buffer.from('%PDF-1.7 mock'),
      );
      expect(layout.title).toBe('Robust Graph Representation Learning');
      expect(layout.authors).toEqual(['Elena Rostova', 'Marcus Vance']);

      const stripped = LayoutExtractor.stripRunningHeadersAndFootersFromText([
        'ACM Transactions — Page 1\nScalable Hybrid Retrieval\nDavid Park\nCopyright 2025 ACM — Page 1 of 18',
        'ACM Transactions — Page 2\n1. Introduction\nHybrid retrieval combines matching.\nCopyright 2025 ACM — Page 2 of 18',
      ]);
      expect(stripped.cleanedText).not.toContain('ACM Transactions — Page 1');
      expect(stripped.cleanedText).not.toContain('Page 1 of 18');
      expect(stripped.cleanedText).toContain('Scalable Hybrid Retrieval');
    });

    it('cascades XMP -> Regex -> Layout, handles pre-OCR sandwich PDFs vs pure scanned PDFs, and respects explicit arXiv stamp year', async () => {
      const extractor = new PdfMetadataExtractor();

      mockedExtractText.mockResolvedValueOnce(`
        Deep Multi-Agent Reinforcement Learning in Stochastic Games
        Sarah Connor, John Connor
        Abstract—We formulate stochastic games with multi-agent reinforcement learning.
        1. Introduction
      `);
      mockedGetDocumentProxy.mockResolvedValueOnce(undefined);

      const plainFallback = await extractor.extract(
        Buffer.from('%PDF-1.4 unstructured'),
      );
      expect(plainFallback.metadata.title).toBe(
        'Deep Multi-Agent Reinforcement Learning in Stochastic Games',
      );
      expect(plainFallback.metadata.authors).toEqual([
        'Sarah Connor',
        'John Connor',
      ]);
      expect(plainFallback.provenance.engineUsed).toBe('LAYOUT');

      const sandwichDocProxy = {
        numPages: 1,
        getPage: jest.fn().mockResolvedValue({
          cleanup: jest.fn(),
          getTextContent: jest.fn().mockResolvedValue({
            items: [
              {
                str: 'arXiv:1706.03762v7 [cs.CL] 2 Aug 2023\nAttention Is All You Need\nAshish Vaswani, Noam Shazeer',
                transform: [14, 0, 0, 14, 50, 700],
                hasEOL: true,
              },
            ],
          }),
        }),
      };
      const stampRes = await extractor.extract(
        Buffer.from('%PDF-1.7 stamp'),
        'paper.pdf',
        sandwichDocProxy as never,
      );
      expect(stampRes.metadata.arxivId).toBe('1706.03762v7');
      expect(stampRes.metadata.year).toBe(2023);

      const pureScanDocProxy = {
        numPages: 1,
        getPage: jest.fn().mockResolvedValue({
          cleanup: jest.fn(),
          getTextContent: jest.fn().mockResolvedValue({ items: [] }),
        }),
      };
      const pureScanRes = await extractor.extract(
        Buffer.from('%PDF-1.7 pure-scan'),
        'scan_001.pdf',
        pureScanDocProxy as never,
      );
      expect(pureScanRes.metadata.doi).toBeUndefined();
      expect(pureScanRes.metadata.title).toBe('scan 001');
      expect(pureScanRes.provenance.rawMatches?.titleFromFilename).toBe(true);
    });
  });

  describe('PdfProvider, PdfTextMetadataExtractor & Bibliography Reference Splitter', () => {
    it('indexes all pages by default, bounds headerOnly to 3 pages, and supports skipTrustedExtraction', async () => {
      mockedGetMeta.mockResolvedValue({
        info: { Title: 'Header Extracted Paper Title' },
      });
      const getPage = jest.fn(async (pageNumber: number) => ({
        getTextContent: jest.fn().mockResolvedValue({
          items: [
            {
              str: `Page ${pageNumber} contains enough searchable text for indexing.`,
            },
          ],
        }),
      }));
      mockedGetDocumentProxy.mockResolvedValue({ numPages: 30, getPage });

      const trustedExtractor = { extract: jest.fn() };
      const provider = new PdfProvider(trustedExtractor as never);

      const full = await provider.extractDocumentFromBuffer(
        Buffer.from('%PDF fixture'),
      );
      expect(full.pages).toHaveLength(30);

      getPage.mockClear();
      trustedExtractor.extract.mockClear();
      const headerOnly = await provider.extractDocumentFromBuffer(
        Buffer.from('%PDF fixture'),
        { headerOnly: true, skipTrustedExtraction: true },
      );
      expect(headerOnly.pages).toHaveLength(3);
      expect(getPage).toHaveBeenCalledTimes(3);
      expect(trustedExtractor.extract).not.toHaveBeenCalled();
      expect(headerOnly.metadata.title).toBe('Header Extracted Paper Title');
    });

    it('ignores TOC References lines during front-matter extraction and parses numbered & unnumbered APA/ICLR reference lists', () => {
      const textExtractor = new PdfTextMetadataExtractor();
      const textWithToc = [
        'Table of Contents',
        'References ..................... 42',
        'Prior work by Smith et al. [1] (10.1145/1111111) explored linear models.',
        'DOI: 10.1038/s41586-024-08888-9',
        'ISBN: 978-0-262-03384-8',
        'ISSN: 0028-0836',
        'PMID: 38123456',
        'References',
        '[1] J. Smith, 10.1145/9999999',
      ].join('\n');

      expect(textExtractor.extractMetadataFromText(textWithToc)).toMatchObject({
        doi: '10.1038/s41586-024-08888-9',
        isbn: '9780262033848',
        issn: '0028-0836',
        pmid: '38123456',
      });

      expect(
        splitCitationSentences(
          'C.-Y. Lee, S. Xie, and Z. Tu. Deeply-supervised nets. arXiv:1409.5185, 2014.',
        ),
      ).toEqual([
        'C.-Y. Lee, S. Xie, and Z. Tu',
        'Deeply-supervised nets',
        'arXiv:1409.5185, 2014.',
      ]);

      const numberedRefs = extractPdfBibliographyReferences(`
References
[9] I. J. Goodfellow, D. Warde-Farley, and Y. Bengio. Maxout networks. arXiv:1302.4389, 2013.
[24] C.-Y. Lee, S. Xie, and Z. Tu. Deeply-supervised nets. arXiv:1409.5185, 2014.
      `);
      expect(numberedRefs).toHaveLength(2);
      expect(numberedRefs[0].title).toBe('Maxout networks');
      expect(numberedRefs[1].arxivId).toBe('1409.5185');

      const unnumberedRefs = extractPdfBibliographyReferences(`
R EFERENCES
Duchi, John, Hazan, Elad, and Singer, Yoram. Adaptive subgradient methods for online learning and
stochastic optimization. The Journal of Machine Learning Research, 12:2121-2159, 2011.
Graves, Alex. Generating sequences with recurrent neural networks. arXiv preprint arXiv:1308.0850,
2013.
      `);
      expect(unnumberedRefs).toHaveLength(2);
      expect(unnumberedRefs[0].year).toBe(2011);
      expect(unnumberedRefs[1].arxivId).toBe('1308.0850');
    });
  });
});
