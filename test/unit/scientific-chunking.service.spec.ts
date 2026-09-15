import { ScientificChunkingService } from '@/modules/ai/ingestion/services/scientific-chunking.service';
import { ExtractedPdfDocument } from '@/modules/library/attachments/providers/pdf.provider';

describe('ScientificChunkingService Unit Suite', () => {
  let service: ScientificChunkingService;

  beforeEach(() => {
    service = new ScientificChunkingService();
  });

  it('should chunk document using GROBID structured sections when available', () => {
    const mockDoc: ExtractedPdfDocument = {
      metadata: {
        title: 'Attention Is All You Need',
        authors: [
          'Ashish Vaswani',
          'Noam Shazeer',
          'Niki Parmar',
          'Jakob Uszkoreit',
        ],
        year: 2017,
        doi: '10.48550/arXiv.1706.03762',
      },
      pages: [],
      sections: [
        {
          id: 'sec-1',
          num: '1',
          title: 'Introduction',
          paragraphs: [
            'Recurrent neural networks, long short-term memory and gated recurrent neural networks in particular, have been firmly established as state of the art approaches in sequence modeling.',
          ],
          page: 1,
          imradCategory: 'introduction',
        },
        {
          id: 'sec-2',
          num: '3',
          title: 'Model Architecture',
          paragraphs: [
            'Most competitive neural sequence transduction models have an encoder-decoder structure. Here, the encoder maps an input sequence of symbol representations to a sequence of continuous representations.',
          ],
          page: 2,
          imradCategory: 'methods',
        },
      ],
    };

    const chunks = service.chunkPdfDocument(mockDoc);

    expect(chunks.length).toBe(2);

    // Verify first chunk
    expect(chunks[0].section).toBe('Introduction');
    expect(chunks[0].headerAttribution).toContain('Attention Is All You Need');
    expect(chunks[0].headerAttribution).toContain('(2017)');
    expect(chunks[0].headerAttribution).toContain(
      'Ashish Vaswani, Noam Shazeer, Niki Parmar et al.',
    );
    expect(chunks[0].headerAttribution).toContain('Section: "Introduction"');
    expect(chunks[0].headerAttribution).toContain('Page: 1');

    // Verify second chunk
    expect(chunks[1].section).toBe('Model Architecture');
    expect(chunks[1].headerAttribution).toContain(
      'Section: "Model Architecture"',
    );
    expect(chunks[1].headerAttribution).toContain('Page: 2');
  });

  it('should chunk document by pages and detect section headings from raw text', () => {
    const mockDoc: ExtractedPdfDocument = {
      metadata: {
        title: 'Deep Residual Learning for Image Recognition',
        authors: ['Kaiming He', 'Xiangyu Zhang'],
        year: 2016,
      },
      pages: [
        {
          pageIndex: 0,
          charOffset: 0,
          textContent:
            '1. Introduction\nDeep convolutional neural networks have led to a series of breakthroughs for image classification.\n\n3. Methodology\nWe present a residual learning framework to ease the training of networks.',
        },
      ],
    };

    const chunks = service.chunkPdfDocument(mockDoc);

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.some((c) => c.section.includes('Introduction'))).toBe(true);
    expect(chunks.some((c) => c.section.includes('Methodology'))).toBe(true);
    expect(chunks[0].headerAttribution).toContain('Page: 1');
  });

  it('should respect maxChunkSize and split long paragraphs with overlap', () => {
    const longText = 'A'.repeat(2500);
    const mockDoc: ExtractedPdfDocument = {
      metadata: {
        title: 'Long Research Data Paper',
        authors: ['Researcher A'],
      },
      pages: [
        {
          pageIndex: 0,
          charOffset: 0,
          textContent: longText,
        },
      ],
    };

    const chunks = service.chunkPdfDocument(mockDoc, {
      maxChunkSize: 1000,
      overlapSize: 100,
    });

    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(1000);
    }
  });

  it('should fallback gracefully to rawText metadata if pages and sections are empty', () => {
    const mockDoc: ExtractedPdfDocument = {
      metadata: {
        title: 'Fallback Paper',
        rawText:
          'This is plain unparsed text from a scanned or corrupted PDF stream.',
      },
      pages: [],
    };

    const chunks = service.chunkPdfDocument(mockDoc);

    expect(chunks.length).toBe(1);
    expect(chunks[0].section).toBe('General');
    expect(chunks[0].content).toContain('This is plain unparsed text');
  });
});
