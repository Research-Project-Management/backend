import {
  cleanAbstractText,
  cleanBibliographicText,
} from '../../src/modules/library/items/utils/items.utils';
import { normalizeAcademicTags } from '../../src/modules/library/tags/utils/tags.utils';
import { RisParser } from '../../src/modules/library/ingestion/parsers/ris.parser';
import { ItemsMapper } from '../../src/modules/library/items/mappers/items.mapper';
import { ReconciliationPolicy } from '../../src/modules/library/ingestion/policies/reconciliation.policy';

describe('Library Metadata Extraction, Cleaning & Ingestion Health', () => {
  describe('cleanAbstractText - Comprehensive Cleaning & JATS/Copyright Noise Removal', () => {
    it('should strip leading "Abstract:" or "ABSTRACT —" prefixes', () => {
      const input = 'Abstract — Deep learning has transformed computer vision.';
      const output = cleanAbstractText(input);
      expect(output).toBe('Deep learning has transformed computer vision.');

      const inputColon =
        'ABSTRACT: Recent advances in natural language processing.';
      expect(cleanAbstractText(inputColon)).toBe(
        'Recent advances in natural language processing.',
      );

      const inputSummary =
        'Summary. We propose a novel architecture for transformers.';
      expect(cleanAbstractText(inputSummary)).toBe(
        'We propose a novel architecture for transformers.',
      );
    });

    it('should clean JATS XML titles and paragraph tags preserving structured formatting', () => {
      const input =
        '<jats:title>Abstract</jats:title><jats:p>Deep residual networks achieve superior accuracy on ImageNet.</jats:p>';
      const output = cleanAbstractText(input);
      expect(output).toBe(
        'Deep residual networks achieve superior accuracy on ImageNet.',
      );
    });

    it('should format structured abstracts with section headings nicely', () => {
      const input = `
        <jats:sec>
          <jats:title>Background</jats:title>
          <jats:p>Medical diagnosis requires high precision models.</jats:p>
        </jats:sec>
        <jats:sec>
          <jats:title>Methods</jats:title>
          <jats:p>We evaluated 1,000 patient records across three hospitals.</jats:p>
        </jats:sec>
        <jats:sec>
          <jats:title>Results</jats:title>
          <jats:p>The model attained 98.5% sensitivity.</jats:p>
        </jats:sec>
      `;
      const output = cleanAbstractText(input);
      expect(output).toContain(
        'Background: Medical diagnosis requires high precision models.',
      );
      expect(output).toContain(
        'Methods: We evaluated 1,000 patient records across three hospitals.',
      );
      expect(output).toContain(
        'Results: The model attained 98.5% sensitivity.',
      );
    });

    it('should format PubMed <AbstractText Label="..."> structured abstracts', () => {
      const input =
        '<AbstractText Label="OBJECTIVE">To assess clinical outcomes.</AbstractText><AbstractText Label="CONCLUSIONS">The treatment is highly effective.</AbstractText>';
      const output = cleanAbstractText(input);
      expect(output).toContain('OBJECTIVE: To assess clinical outcomes.');
      expect(output).toContain(
        'CONCLUSIONS: The treatment is highly effective.',
      );
    });

    it('should strip publisher copyright banners (Elsevier, Springer Nature, Wiley, MDPI, IEEE)', () => {
      // Elsevier
      const elsevier =
        'Neural networks learn hierarchical representations. © 2023 Elsevier B.V. All rights reserved.';
      expect(cleanAbstractText(elsevier)).toBe(
        'Neural networks learn hierarchical representations.',
      );

      // Springer Nature
      const springer =
        'Quantum computing exhibits exponential speedup. © The Author(s) 2024. Springer Nature Switzerland AG.';
      expect(cleanAbstractText(springer)).toBe(
        'Quantum computing exhibits exponential speedup.',
      );

      // Wiley
      const wiley =
        'Cardiovascular risk correlates with lifestyle factors. Copyright © 2024 John Wiley & Sons, Ltd.';
      expect(cleanAbstractText(wiley)).toBe(
        'Cardiovascular risk correlates with lifestyle factors.',
      );

      // MDPI
      const mdpi =
        'Remote sensing enables wildfire monitoring. © 2023 by the authors. Licensee MDPI, Basel, Switzerland.';
      expect(cleanAbstractText(mdpi)).toBe(
        'Remote sensing enables wildfire monitoring.',
      );

      // IEEE
      const ieee =
        'The proposed radar filter improves signal to noise ratio. © 2024 IEEE. Personal use is permitted.';
      expect(cleanAbstractText(ieee)).toBe(
        'The proposed radar filter improves signal to noise ratio.',
      );
    });

    it('should strip trailing Index Terms, Keywords, and PACS noise', () => {
      const input =
        'Diffusion models generate high-fidelity samples. Index Terms— Diffusion, generative models, deep learning.';
      expect(cleanAbstractText(input)).toBe(
        'Diffusion models generate high-fidelity samples.',
      );

      const inputKeywords =
        'Graph neural networks capture molecular topology. Keywords: GNN, drug discovery, chemistry.';
      expect(cleanAbstractText(inputKeywords)).toBe(
        'Graph neural networks capture molecular topology.',
      );
    });

    it('should normalize spaced punctuation from OpenAlex inverted index decoding', () => {
      const spaced =
        'In this study ( e.g. , ResNet ) , the accuracy reached 95 % . Furthermore , it was tested on ImageNet .';
      const output = cleanAbstractText(spaced);
      expect(output).toBe(
        'In this study (e.g., ResNet), the accuracy reached 95%. Furthermore, it was tested on ImageNet.',
      );
    });

    it('should fix hyphenation broken across line breaks', () => {
      const broken =
        'We propose a stochas-\n  tic gradient optimization method.';
      const output = cleanAbstractText(broken);
      expect(output).toBe(
        'We propose a stochastic gradient optimization method.',
      );
    });
  });

  describe('Tags & Keywords Extraction & Normalization', () => {
    it('should preserve Title Case and uppercase acronyms in normalizeAcademicTags', () => {
      const tags = [
        'ai',
        'ml',
        'bert',
        'covid-19',
        'deep learning',
        'computer vision',
      ];
      const normalized = normalizeAcademicTags(tags);
      expect(normalized).toContain('AI');
      expect(normalized).toContain('ML');
      expect(normalized).toContain('BERT');
      expect(normalized).toContain('COVID-19');
      expect(normalized).toContain('Deep Learning');
      expect(normalized).toContain('Computer Vision');
    });

    it('should not lowercase scientific acronyms during reconciliation', () => {
      const policy = new ReconciliationPolicy();
      const decision = policy.reconcile([
        {
          candidateId: 'c1',
          sourceKind: 'IDENTIFIER',
          sourceName: 'DirectIdentifier',
          retrievedAt: new Date().toISOString(),
          schemaVersion: '1.0',
          normalizedMetadata: { title: 'Test 1' },
          confidenceScore: 0.95,
          fields: {
            tags: {
              path: 'tags',
              value: ['AI', 'BERT'],
              normalizedValue: ['AI', 'BERT'],
              confidence: 0.95,
              sourceProvider: 'DirectIdentifier',
              retrievedAt: new Date().toISOString(),
            },
          },
        },
        {
          candidateId: 'c2',
          sourceKind: 'PROVIDER',
          sourceName: 'CrossRef',
          retrievedAt: new Date().toISOString(),
          schemaVersion: '1.0',
          normalizedMetadata: { title: 'Test 2' },
          confidenceScore: 0.9,
          fields: {
            tags: {
              path: 'tags',
              value: ['machine learning', 'covid-19'],
              normalizedValue: ['machine learning', 'covid-19'],
              confidence: 0.9,
              sourceProvider: 'CrossRef',
              retrievedAt: new Date().toISOString(),
            },
          },
        },
      ]);

      expect(decision.proposedItem.tags).toContain('AI');
      expect(decision.proposedItem.tags).toContain('BERT');
      expect(decision.proposedItem.tags).toContain('COVID-19');
      expect(decision.proposedItem.tags).toContain('Machine Learning');
    });
  });

  describe('RIS Parser - Keyword and Notes Extraction', () => {
    const risParser = new RisParser();

    it('should extract all KW keywords and RN / N1 notes from RIS record', () => {
      const risContent = `
TY  - JOUR
TI  - Deep Residual Learning for Image Recognition
AU  - He, Kaiming
AU  - Zhang, Xiangyu
AU  - Ren, Shaoqing
AU  - Sun, Jian
JO  - IEEE Conference on Computer Vision and Pattern Recognition
PY  - 2016
DO  - 10.1109/CVPR.2016.90
KW  - Computer Vision
KW  - Residual Networks
KW  - Deep Learning
RN  - Research note: landmark paper introducing skip connections.
N1  - Additional comment: Winner of ILSVRC 2015.
AB  - Deeper neural networks are more difficult to train. We present a residual learning framework to ease the training of networks that are substantially deeper than those used previously.
ER  -
      `.trim();

      const items = risParser.parse(risContent);
      expect(items.length).toBe(1);
      const item = items[0];

      expect(item.title).toBe('Deep Residual Learning for Image Recognition');
      expect(item.tags).toEqual(
        expect.arrayContaining([
          'Computer Vision',
          'Residual Networks',
          'Deep Learning',
        ]),
      );
      expect(item.notes).toBeDefined();
      expect(item.notes?.length).toBe(2);
      expect(item.notes?.[0].content).toContain(
        'Research note: landmark paper introducing skip connections.',
      );
      expect(item.notes?.[1].content).toContain(
        'Additional comment: Winner of ILSVRC 2015.',
      );
      expect(item.abstract).toContain(
        'Deeper neural networks are more difficult to train.',
      );
    });

    it('should extract multi-line continuations in fallback line parser', () => {
      const nonStandardRis = `
TY  - JOUR
TI  - Multi-line Title
 Part Two
AU  - Turing, Alan
AB  - This is line one of the abstract.
 This is line two of the abstract continuing seamlessly.
RN  - Note line one.
 Note line two continuation.
KW  - AI
ER  -
      `.trim();

      const items = (risParser as any).fallbackParse(nonStandardRis);
      expect(items.length).toBe(1);
      const item = items[0];

      expect(item.title).toContain('Multi-line Title Part Two');
      expect(item.abstract).toContain(
        'This is line one of the abstract. This is line two of the abstract continuing seamlessly.',
      );
      expect(item.notes?.[0].content).toContain(
        'Note line one. Note line two continuation.',
      );
      expect(item.tags).toContain('AI');
    });
  });

  describe('ItemsMapper - OpenAccess PDF & Notes Projection', () => {
    it('should preserve external OpenAccess PDF URL and not wipe it out', () => {
      const rawDbItem = {
        id: '11111111-1111-1111-1111-111111111111',
        title: 'Attention Is All You Need',
        itemType: 'journalArticle',
        fileUrl: 'https://arxiv.org/pdf/1706.03762.pdf',
        openAccessPdfUrl: 'https://arxiv.org/pdf/1706.03762.pdf',
        abstract:
          'Abstract: The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.',
        notesList: [
          {
            id: 'note-1',
            title: 'Note 1',
            contentMd: 'Key paper introducing Transformers.',
            createdAt: new Date(),
          },
        ],
        extraFields: {},
      };

      const domainItem: any = ItemsMapper.toDomain(rawDbItem);

      // fileUrl preserved for PDF reader
      expect(domainItem.fileUrl).toBe('https://arxiv.org/pdf/1706.03762.pdf');
      expect(domainItem.openAccessPdfUrl).toBe(
        'https://arxiv.org/pdf/1706.03762.pdf',
      );

      // abstract cleaned of leading Abstract:
      expect(domainItem.abstract).toBe(
        'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.',
      );

      // notes mapped from notesList
      expect(domainItem.notes).toBeDefined();
      expect(domainItem.notes.length).toBe(1);
      expect(domainItem.notes[0].content).toBe(
        'Key paper introducing Transformers.',
      );
    });
  });
});
