import { XmpParser } from '@/modules/library/extraction/extractors/xmp.parser';
import { AcademicRegexCatalog } from '@/modules/library/extraction/extractors/academic-regex.catalog';
import { MetadataQualityGate } from '@/modules/library/extraction/extractors/metadata-quality.gate';
import { LayoutHeuristicExtractor } from '@/modules/library/extraction/extractors/layout-heuristic.extractor';
import { TrustedExtractionService } from '@/modules/library/extraction/services/trusted-extraction.service';
import { ReconciliationPolicy } from '@/modules/library/ingestion/policies/reconciliation.policy';
import { EnrichStage } from '@/modules/library/ingestion/stages/enrich.stage';
import { MetadataCandidate } from '@/modules/library/ingestion/types/metadata-candidate.types';
import { extractText, getDocumentProxy } from 'unpdf';

jest.mock('unpdf', () => ({
  extractText: jest.fn(),
  getDocumentProxy: jest.fn(),
  getMeta: jest.fn(),
}));

describe('Trusted In-Process Academic Extraction Engine', () => {
  const mockedExtractText = extractText as jest.Mock;
  const mockedGetDocumentProxy = getDocumentProxy as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 1. ISO 16684-1:2019 XMP Binary Packet Parser
  // ───────────────────────────────────────────────────────────────────────────
  describe('XmpParser (Tier 1)', () => {
    it('extracts complete Dublin Core and PRISM metadata from an XML packet', () => {
      const xmlPacket = `
        <x:xmpmeta xmlns:x="adobe:ns:meta/">
          <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"
                             xmlns:prism="http://prismstandard.org/namespaces/basic/2.0/">
              <prism:doi>10.1038/s41586-020-2649-2</prism:doi>
              <dc:title>
                <rdf:Alt>
                  <rdf:li xml:lang="x-default">Attention Is All You Need &amp; Transformers</rdf:li>
                </rdf:Alt>
              </dc:title>
              <dc:creator>
                <rdf:Seq>
                  <rdf:li>Ashish Vaswani</rdf:li>
                  <rdf:li>Noam Shazeer</rdf:li>
                  <rdf:li>Niki Parmar</rdf:li>
                </rdf:Seq>
              </dc:creator>
              <prism:publicationDate>2017-06-12</prism:publicationDate>
              <prism:publicationName>Advances in Neural Information Processing Systems</prism:publicationName>
              <prism:publisher>Curran Associates, Inc.</prism:publisher>
              <dc:description>
                <rdf:Alt>
                  <rdf:li>The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.</rdf:li>
                </rdf:Alt>
              </dc:description>
              <dc:subject>
                <rdf:Bag>
                  <rdf:li>Deep Learning</rdf:li>
                  <rdf:li>Natural Language Processing</rdf:li>
                </rdf:Bag>
              </dc:subject>
            </rdf:Description>
          </rdf:RDF>
        </x:xmpmeta>
      `;

      const buffer = Buffer.concat([
        Buffer.from('%PDF-1.7\n%âãÏÓ\n'),
        Buffer.from(xmlPacket, 'utf-8'),
        Buffer.from('\n%%EOF'),
      ]);

      const parsed = XmpParser.parse(buffer);
      expect(parsed).not.toBeNull();
      expect(parsed?.doi).toBe('10.1038/s41586-020-2649-2');
      expect(parsed?.title).toBe('Attention Is All You Need & Transformers');
      expect(parsed?.authors).toEqual([
        'Ashish Vaswani',
        'Noam Shazeer',
        'Niki Parmar',
      ]);
      expect(parsed?.year).toBe(2017);
      expect(parsed?.journal).toBe(
        'Advances in Neural Information Processing Systems',
      );
      expect(parsed?.publisher).toBe('Curran Associates, Inc.');
      expect(parsed?.description).toContain(
        'The dominant sequence transduction models',
      );
      expect(parsed?.keywords).toEqual([
        'Deep Learning',
        'Natural Language Processing',
      ]);
    });

    it('returns null when buffer has no XMP packet', () => {
      const buffer = Buffer.from('%PDF-1.4 empty pdf without any metadata');
      const parsed = XmpParser.parse(buffer);
      expect(parsed).toBeNull();
    });

    it('scans the trailer chunk when XMP is appended in incremental updates', () => {
      const headerPadding = Buffer.alloc(70000, 0x20); // 70KB padding to push XMP past 64KB
      const trailerXmp = `
        <x:xmpmeta xmlns:x="adobe:ns:meta/">
          <prism:doi>10.1145/3377811.3380321</prism:doi>
          <dc:title>Incremental Trailer Update Paper</dc:title>
        </x:xmpmeta>
      `;
      const buffer = Buffer.concat([
        Buffer.from('%PDF-1.5\n'),
        headerPadding,
        Buffer.from(trailerXmp, 'utf-8'),
        Buffer.from('\n%%EOF'),
      ]);

      const parsed = XmpParser.parse(buffer);
      expect(parsed).not.toBeNull();
      expect(parsed?.doi).toBe('10.1145/3377811.3380321');
      expect(parsed?.title).toBe('Incremental Trailer Update Paper');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Academic Regex Catalog
  // ───────────────────────────────────────────────────────────────────────────
  describe('AcademicRegexCatalog (Tier 2)', () => {
    it('detects ISO 26324 DOI with punctuation cleanup', () => {
      const text =
        'Published in Nature 2021. https://doi.org/10.1038/s41586-021-03819-2. Received 10 Jan 2021.';
      const res = AcademicRegexCatalog.scan(text);
      expect(res.doi).toBe('10.1038/s41586-021-03819-2');
      expect(res.matchedSignatures).toContain('DOI_ISO26324');
    });

    it('handles multiline broken DOIs from column layouts', () => {
      const text =
        'Digital Object Identifier 10.1109/\nCVPR.2023.12345 in proceedings';
      const res = AcademicRegexCatalog.scan(text);
      expect(res.doi).toBe('10.1109/CVPR.2023.12345');
    });

    it('extracts new-style and old-style arXiv IDs and sets canonical arXiv DOI', () => {
      const newArxiv =
        'arXiv:2303.08774v2 [cs.CV] 15 Mar 2023. Title: Scaling Vision Transformers';
      const resNew = AcademicRegexCatalog.scan(newArxiv);
      expect(resNew.arxivId).toBe('2303.08774v2');
      expect(resNew.primaryCategory).toBe('cs.CV');
      expect(resNew.doi).toBe('10.48550/arXiv.2303.08774v2');
      expect(resNew.matchedSignatures).toContain('ARXIV_SCHEME');

      const oldArxiv =
        'hep-th/9711200v1 27 Nov 1997. Large N Limit of Conformal Field Theories';
      const resOld = AcademicRegexCatalog.scan(oldArxiv);
      expect(resOld.arxivId).toBe('hep-th/9711200v1');
      expect(resOld.doi).toBe('10.48550/arXiv.hep-th/9711200v1');
    });

    it('extracts IEEE transaction citation stamps', () => {
      const text =
        'IEEE Transactions on Pattern Analysis and Machine Intelligence, vol. 44, no. 12, pp. 9123-9135, Dec. 2022.';
      const res = AcademicRegexCatalog.scan(text);
      expect(res.publisher).toBe('IEEE');
      expect(res.journal).toBe('Pattern Analysis and Machine Intelligence');
      expect(res.volume).toBe('44');
      expect(res.issue).toBe('12');
      expect(res.pages).toBe('9123-9135');
      expect(res.year).toBe(2022);
      expect(res.matchedSignatures).toContain('IEEE_STAMP');
    });

    it('extracts ACM Reference Format blocks', () => {
      const text =
        'ACM Reference Format:\nJohn Doe and Jane Smith. 2023. Efficient Deep Learning at Scale. In Proceedings of the 2023 ACM SIGMOD Conference, Article 42, 14 pages.';
      const res = AcademicRegexCatalog.scan(text);
      expect(res.publisher).toBe('ACM');
      expect(res.year).toBe(2023);
      expect(res.authors).toEqual(['John Doe', 'Jane Smith']);
      expect(res.title).toBe('Efficient Deep Learning at Scale');
      expect(res.journal).toBe('Proceedings of the 2023 ACM SIGMOD Conference');
      expect(res.matchedSignatures).toContain('ACM_REFERENCE_FORMAT');
    });

    it('extracts Abstract section bounded to prevent ReDoS', () => {
      const text = `
        Title of the Paper
        Abstract—This paper presents an end-to-end framework for local metadata extraction from academic PDF documents without relying on external web services.
        1. Introduction
        In recent years, deep learning has advanced significantly...
      `;
      const res = AcademicRegexCatalog.scan(text);
      expect(res.abstract).toContain(
        'This paper presents an end-to-end framework',
      );
      expect(res.abstract).not.toContain('1. Introduction');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Metadata Quality Gate (Deterministic Decision Boundary S >= 0.85)
  // ───────────────────────────────────────────────────────────────────────────
  describe('MetadataQualityGate (Decision Boundary)', () => {
    it('accepts complete academic record as self-sufficient (score >= 0.85)', () => {
      const metadata = {
        title: 'Attention Is All You Need',
        authors: ['Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar'],
        doi: '10.1038/s41586-020-2649-2',
        year: 2017,
        journal: 'Advances in Neural Information Processing Systems',
      };

      const result = MetadataQualityGate.evaluate(metadata);
      expect(result.breakdown.titleScore).toBe(1.0);
      expect(result.breakdown.authorScore).toBe(1.0);
      expect(result.breakdown.identifierScore).toBe(1.0);
      expect(result.breakdown.yearScore).toBe(1.0);
      expect(result.breakdown.venueScore).toBe(1.0);
      expect(result.breakdown.totalScore).toBe(1.0);
      expect(result.isSelfSufficient).toBe(true);
      expect(result.missingFields).toHaveLength(0);
    });

    it('accepts paper with arXiv ID, title, authors, and year (score = 0.90)', () => {
      const metadata = {
        title: 'Deep Residual Learning for Image Recognition',
        authors: ['Kaiming He', 'Xiangyu Zhang', 'Shaoqing Ren', 'Jian Sun'],
        arxivId: '1512.03385',
        year: 2015,
      };

      const result = MetadataQualityGate.evaluate(metadata);
      // Title (0.30) + Authors (0.25) + Identifier (0.20) + Year (0.15) = 0.90
      expect(result.breakdown.totalScore).toBe(0.9);
      expect(result.isSelfSufficient).toBe(true);
      expect(result.missingFields).toContain('journal/publisher');
    });

    it('rejects garbage title ("untitled", "microsoft word", filename) from self-sufficiency', () => {
      const metadata = {
        title: 'untitled document.pdf',
        authors: ['John Doe'],
        doi: '10.1038/nature12345',
        year: 2021,
      };

      const result = MetadataQualityGate.evaluate(metadata);
      expect(result.breakdown.titleScore).toBe(0.0);
      // Total: 0 + 0.25 + 0.20 + 0.15 = 0.60 < 0.85
      expect(result.breakdown.totalScore).toBeLessThan(0.85);
      expect(result.isSelfSufficient).toBe(false);
      expect(result.missingFields).toContain('title');
    });

    it('rejects papers without identifiers or authors', () => {
      const metadata = {
        title: 'A Random Scanned Document Without Metadata',
        year: 2020,
      };

      const result = MetadataQualityGate.evaluate(metadata);
      expect(result.isSelfSufficient).toBe(false);
      expect(result.missingFields).toEqual(
        expect.arrayContaining(['authors', 'doi/arxivId']),
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Layout Heuristic Extractor (Tier 3)
  // ───────────────────────────────────────────────────────────────────────────
  describe('LayoutHeuristicExtractor (Tier 3)', () => {
    it('ranks largest font size text in top half as Title and succeeding lines as Authors', async () => {
      mockedGetDocumentProxy.mockResolvedValue({
        numPages: 5,
        getPage: jest.fn().mockResolvedValue({
          getViewport: () => ({ width: 612, height: 792 }),
          getTextContent: jest.fn().mockResolvedValue({
            items: [
              // Running Header at very top (y = 750, small font 9pt)
              {
                str: 'JOURNAL OF COMPUTER VISION 2023',
                transform: [9, 0, 0, 9, 50, 750],
              },
              // Title lines (y = 700, 680, large font 22pt)
              {
                str: 'Self-Supervised Visual Representation',
                transform: [22, 0, 0, 22, 50, 700],
              },
              {
                str: 'Learning With Deep Transformers',
                transform: [22, 0, 0, 22, 50, 680],
              },
              // Author line (y = 640, medium font 12pt)
              {
                str: 'Alice Chen, Bob Martin, Charlie Davis',
                transform: [12, 0, 0, 12, 50, 640],
              },
              // Affiliation line (y = 620, small font 10pt)
              {
                str: 'Department of Computer Science, MIT',
                transform: [10, 0, 0, 10, 50, 620],
              },
              // Abstract paragraph (y = 560, font 10pt)
              {
                str: 'Abstract—We propose a novel contrastive learning framework...',
                transform: [10, 0, 0, 10, 50, 560],
              },
            ],
          }),
        }),
      });

      const buffer = Buffer.from('%PDF-1.7 mock layout stream');
      const layout = await LayoutHeuristicExtractor.extract(buffer);

      expect(layout.title).toBe(
        'Self-Supervised Visual Representation Learning With Deep Transformers',
      );
      expect(layout.authors).toEqual([
        'Alice Chen',
        'Bob Martin',
        'Charlie Davis',
      ]);
      expect(layout.maxFontSize).toBe(22);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. Master Facade Orchestration (TrustedExtractionFacade)
  // ───────────────────────────────────────────────────────────────────────────
  describe('TrustedExtractionFacade (Multi-Tier Orchestration)', () => {
    it('executes Tier 1 (XMP) and succeeds fast when XMP contains full metadata', async () => {
      const xmlPacket = `
        <x:xmpmeta xmlns:x="adobe:ns:meta/">
          <prism:doi>10.1038/s41586-020-2649-2</prism:doi>
          <dc:title>Mastering the Game of Go with Deep Neural Networks</dc:title>
          <dc:creator>
            <rdf:Seq>
              <rdf:li>David Silver</rdf:li>
              <rdf:li>Demis Hassabis</rdf:li>
            </rdf:Seq>
          </dc:creator>
          <prism:publicationDate>2016-01-28</prism:publicationDate>
          <prism:publicationName>Nature</prism:publicationName>
        </x:xmpmeta>
      `;
      const buffer = Buffer.concat([
        Buffer.from('%PDF-1.7\n'),
        Buffer.from(xmlPacket, 'utf-8'),
        Buffer.from('\n%%EOF'),
      ]);

      mockedExtractText.mockResolvedValue('');

      const facade = new TrustedExtractionService();
      const result = await facade.extract(buffer);

      expect(result.isSelfSufficient).toBe(true);
      expect(result.provenance.engineUsed).toBe('XMP_BINARY');
      expect(result.metadata.title).toBe(
        'Mastering the Game of Go with Deep Neural Networks',
      );
      expect(result.metadata.doi).toBe('10.1038/s41586-020-2649-2');
      expect(result.metadata.authors).toEqual([
        'David Silver',
        'Demis Hassabis',
      ]);
      expect(result.metadata.journal).toBe('Nature');
      expect(result.quality.totalScore).toBe(1.0);
    });

    it('cascades to Tier 2 (Academic Regex) when XMP is absent', async () => {
      const buffer = Buffer.from('%PDF-1.7 raw buffer without xmp');
      mockedExtractText.mockResolvedValue(`
        arXiv:2303.08774v2 [cs.CV] 15 Mar 2023
        Scaling Vision Transformers to 22 Billion Parameters
        Mostafa Dehghani, Josip Djolonga, Alexey Dosovitskiy
        Abstract—We introduce ViT-22B, currently the largest vision model...
      `);

      mockedGetDocumentProxy.mockResolvedValue({
        numPages: 1,
        getPage: jest.fn().mockResolvedValue({
          getViewport: () => ({ width: 612, height: 792 }),
          getTextContent: jest.fn().mockResolvedValue({ items: [] }),
        }),
      });

      const facade = new TrustedExtractionService();
      const result = await facade.extract(buffer);

      expect(result.metadata.arxivId).toBe('2303.08774v2');
      expect(result.metadata.doi).toBe('10.48550/arXiv.2303.08774v2');
      expect(['ACADEMIC_REGEX', 'HYBRID']).toContain(
        result.provenance.engineUsed,
      );
    });

    it('cascades to Tier 4 (MeXtract SLM) for preprints without persistent identifiers or XMP', async () => {
      const buffer = Buffer.from('%PDF-1.4 unstructured preprint buffer');
      mockedExtractText.mockResolvedValue(`
        Deep Multi-Agent Reinforcement Learning in Stochastic Games
        Sarah Connor, John Connor
        Cyberdyne Robotics Institute
        Abstract—We formulate stochastic games with multi-agent reinforcement learning.
        1. Introduction
      `);

      mockedGetDocumentProxy.mockResolvedValue({
        numPages: 1,
        getPage: jest.fn().mockResolvedValue({
          getViewport: () => ({ width: 612, height: 792 }),
          getTextContent: jest.fn().mockResolvedValue({ items: [] }),
        }),
      });

      const facade = new TrustedExtractionService();
      const result = await facade.extract(buffer);

      expect(result.metadata.title).toBe(
        'Deep Multi-Agent Reinforcement Learning in Stochastic Games',
      );
      expect(result.metadata.authors).toEqual(['Sarah Connor', 'John Connor']);
      expect(result.provenance.engineUsed).toBe('MEXTRACT_SLM');
      expect(result.provenance.rawMatches?.mextract).toBeDefined();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 6. Ingestion Pipeline Integration (IdentifyStage, EnrichStage, ReconciliationPolicy)
  // ───────────────────────────────────────────────────────────────────────────
  describe('Pipeline Integration: Strangler Fig & Remote API Bypass', () => {
    it('ReconciliationPolicy: TrustedPaper candidate (92) beats CrossRef (90) and EnrichedProvider (85)', () => {
      const trustedCandidate: MetadataCandidate = {
        candidateId: 'cand-trusted-1',
        sourceKind: 'FILE',
        sourceName: 'TrustedPaper',
        sourceRecordId: 'doc-file-123',
        retrievedAt: new Date().toISOString(),
        schemaVersion: '1.0.0',
        confidenceScore: 0.95,
        fields: {
          title: {
            path: 'title',
            value: 'Deep Learning Local Authoritative Title',
            normalizedValue: 'Deep Learning Local Authoritative Title',
            confidence: 0.95,
            sourceProvider: 'TrustedPaper',
            retrievedAt: new Date().toISOString(),
          },
          year: {
            path: 'year',
            value: 2023,
            normalizedValue: 2023,
            confidence: 0.95,
            sourceProvider: 'TrustedPaper',
            retrievedAt: new Date().toISOString(),
          },
        },
        normalizedMetadata: {
          title: 'Deep Learning Local Authoritative Title',
          year: 2023,
        },
      };

      const crossRefCandidate: MetadataCandidate = {
        candidateId: 'cand-crossref-2',
        sourceKind: 'PROVIDER',
        sourceName: 'CrossRef',
        sourceRecordId: '10.1038/example',
        retrievedAt: new Date().toISOString(),
        schemaVersion: '1.0.0',
        confidenceScore: 0.9,
        fields: {
          title: {
            path: 'title',
            value: 'Deep Learning CrossRef Guess',
            normalizedValue: 'Deep Learning CrossRef Guess',
            confidence: 0.9,
            sourceProvider: 'CrossRef',
            retrievedAt: new Date().toISOString(),
          },
          year: {
            path: 'year',
            value: 2022,
            normalizedValue: 2022,
            confidence: 0.9,
            sourceProvider: 'CrossRef',
            retrievedAt: new Date().toISOString(),
          },
        },
        normalizedMetadata: {
          title: 'Deep Learning CrossRef Guess',
          year: 2022,
        },
      };

      const policy = new ReconciliationPolicy();
      const decision = policy.reconcile([crossRefCandidate, trustedCandidate]);

      // TrustedPaper effective score: 0.95 * 92 = 87.4
      // CrossRef effective score: 0.90 * 90 = 81.0
      // Winner must be TrustedPaper!
      expect(decision.proposedItem.title).toBe(
        'Deep Learning Local Authoritative Title',
      );
      expect(decision.selectedFields.title.sourceProvider).toBe('TrustedPaper');
      expect(decision.proposedItem.year).toBe(2023);
    });

    it('EnrichStage: skips external metadataService.resolve() when candidate is TrustedPaper', async () => {
      const mockMetadataService = {
        resolve: jest.fn(),
      };

      const enrichStage = new EnrichStage(mockMetadataService as any);

      const candidates: MetadataCandidate[] = [
        {
          candidateId: 'cand-trusted-99',
          sourceKind: 'FILE',
          sourceName: 'TrustedPaper',
          sourceRecordId: 'file-xyz',
          retrievedAt: new Date().toISOString(),
          schemaVersion: '1.0.0',
          confidenceScore: 0.95,
          fields: {},
          normalizedMetadata: {
            doi: '10.1038/s41586-020-2649-2',
            title: 'Attention Is All You Need',
            isSelfSufficient: true,
          },
        },
      ];

      const result = await enrichStage.execute('test-scope', candidates);

      // Verify that metadataService.resolve was NEVER called
      expect(mockMetadataService.resolve).not.toHaveBeenCalled();
      expect(result).toHaveLength(1);
      expect(result[0].candidateId).toBe('cand-trusted-99');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 7. Latency Performance Benchmark (Target: < 50ms)
  // ───────────────────────────────────────────────────────────────────────────
  describe('Performance & Latency Benchmark', () => {
    it('executes in-process extraction in < 50ms per document', async () => {
      const xmlPacket = `
        <x:xmpmeta xmlns:x="adobe:ns:meta/">
          <prism:doi>10.1145/3377811.3380321</prism:doi>
          <dc:title>High Performance In-Process Metadata Extraction</dc:title>
          <dc:creator>
            <rdf:Seq><rdf:li>Engineer Senior</rdf:li></rdf:Seq>
          </dc:creator>
          <prism:publicationDate>2024</prism:publicationDate>
          <prism:publicationName>ACM Transactions on Software Engineering</prism:publicationName>
        </x:xmpmeta>
      `;
      const buffer = Buffer.concat([
        Buffer.from('%PDF-1.7\n'),
        Buffer.from(xmlPacket, 'utf-8'),
        Buffer.from('\n%%EOF'),
      ]);

      mockedExtractText.mockResolvedValue('');

      const facade = new TrustedExtractionService();

      // Warmup run
      await facade.extract(buffer);

      const iterations = 50;
      const start = performance.now();
      for (let i = 0; i < iterations; i++) {
        const res = await facade.extract(buffer);
        expect(res.isSelfSufficient).toBe(true);
      }
      const elapsed = performance.now() - start;
      const avgMs = elapsed / iterations;

      // Assertion: In-process extraction must take less than 15ms on average (well under 50ms limit)
      expect(avgMs).toBeLessThan(15.0);
    });
  });
});
