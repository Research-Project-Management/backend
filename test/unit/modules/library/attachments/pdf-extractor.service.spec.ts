import { PdfDoiExtractor } from '@/modules/library/legacy/attachments/extractor.service';

/**
 * Tests for PdfDoiExtractor at two public seams:
 *  1. extractFromText() — pure function, no mocks
 *  2. extractFromBuffer() — requires unpdf mock via jest.mock
 *
 * Expected values come from known-good literals (CrossRef DOI format spec).
 */

// Mock unpdf ES module before any imports resolve
jest.mock('unpdf', () => ({
  getDocumentProxy: jest.fn(),
  extractText: jest.fn(),
  getMeta: jest.fn(),
}));

describe('PdfDoiExtractor — extractFromText()', () => {
  let extractor: PdfDoiExtractor;

  beforeEach(() => {
    extractor = new PdfDoiExtractor();
    jest.clearAllMocks();
  });

  it('extracts a well-formed DOI from plain text', () => {
    const text = 'DOI: 10.1145/3377325.3377498\nSome other text';
    expect(extractor.extractFromText(text)).toBe('10.1145/3377325.3377498');
  });

  it('extracts a DOI preceded by the doi.org URL prefix', () => {
    const text = 'Available at https://doi.org/10.1038/s41586-021-03819-2';
    expect(extractor.extractFromText(text)).toBe('10.1038/s41586-021-03819-2');
  });

  it('strips trailing punctuation from the extracted DOI', () => {
    // PDFs often have ". " or "," after DOIs at the end of a sentence
    const text = 'See reference [1] doi:10.1145/3377325.3377498.';
    const result = extractor.extractFromText(text);
    expect(result).toBe('10.1145/3377325.3377498');
    expect(result).not.toMatch(/\.$/);
  });

  it('returns the first DOI when multiple DOIs appear in the text', () => {
    const text = [
      'First: 10.1145/3377325.3377498',
      'Second: 10.1038/s41586-021-03819-2',
    ].join('\n');
    expect(extractor.extractFromText(text)).toBe('10.1145/3377325.3377498');
  });

  it('returns null when no DOI pattern is present', () => {
    const text =
      'This document has no identifier. See example.com for details.';
    expect(extractor.extractFromText(text)).toBeNull();
  });

  it('returns null for empty string input', () => {
    expect(extractor.extractFromText('')).toBeNull();
  });

  it('handles arXiv DOIs (10.48550 prefix)', () => {
    const text = 'DOI: 10.48550/arXiv.1706.03762';
    expect(extractor.extractFromText(text)).toBe('10.48550/arXiv.1706.03762');
  });

  it('extracts arXiv identifier when no DOI is present and formats as canonical arXiv DOI', () => {
    const text =
      'arXiv:2506.08989v1 [cs.LG] 10 Jun 2025\nSwS: Self-aware Weakness-driven Problem Synthesis';
    expect(extractor.extractFromText(text)).toBe('10.48550/arXiv.2506.08989v1');
  });

  it('filters out dummy/placeholder DOIs like 10.1145/nnnnnnn.nnnnnnn', () => {
    const text =
      'ACM Reference Format: Author. 2024. Title. In Proceedings... DOI: 10.1145/nnnnnnn.nnnnnnn';
    expect(extractor.extractFromText(text)).toBeNull();
  });

  it('prefers valid DOI over dummy DOI if both are in text', () => {
    const text =
      'Template: 10.1145/nnnnnnn\nActual: 10.1038/s41586-021-03819-2';
    expect(extractor.extractFromText(text)).toBe('10.1038/s41586-021-03819-2');
  });

  it('only scans the first 50,000 characters of the input', () => {
    const padding = 'a'.repeat(50_001);
    const text = padding + ' 10.1145/3377325.3377498';
    expect(extractor.extractFromText(text)).toBeNull();
  });
});

describe('PdfDoiExtractor — extractMetadataFromText()', () => {
  let extractor: PdfDoiExtractor;

  beforeEach(() => {
    extractor = new PdfDoiExtractor();
  });

  it('extracts abstract, keywords/tags, and arXiv identifier from text', () => {
    const text = `
Deep Learning for Visual Understanding
Zhang Wei, John Smith
arXiv:2401.09876v1 [cs.CV] 18 Jan 2024

Abstract—Visual understanding has witnessed unprecedented breakthroughs with deep neural networks. In this survey, we provide a comprehensive review of state-of-the-art vision models and their applications.

Index Terms—Deep learning, computer vision, neural networks, object detection, visual understanding.

1. INTRODUCTION
During the past decade, computer vision has advanced rapidly...
    `;

    const meta = extractor.extractMetadataFromText(text);
    expect(meta.arxivId).toBe('2401.09876v1');
    expect(meta.abstract).toContain(
      'Visual understanding has witnessed unprecedented breakthroughs',
    );
    expect(meta.keywords).toEqual(
      expect.arrayContaining([
        'Deep learning',
        'computer vision',
        'neural networks',
        'object detection',
      ]),
    );
  });

  it('extracts hyphenated or broken DOIs across lines correctly', () => {
    const text = `
      IEEE Transactions on Software Engineering
      DOI: 10.1109/
      TSE.2023.1234567
      Abstract: Testing broken DOI regex.
    `;
    const meta = extractor.extractMetadataFromText(text);
    expect(meta.doi).toBe('10.1109/TSE.2023.1234567');
  });
});

describe('PdfDoiExtractor — extractFromBuffer()', () => {
  let extractor: PdfDoiExtractor;
  // Get the mocked functions from the jest.mock above
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const unpdfMock = require('unpdf') as {
    getDocumentProxy: jest.Mock;
    extractText: jest.Mock;
    getMeta: jest.Mock;
  };

  beforeEach(() => {
    extractor = new PdfDoiExtractor();
    jest.clearAllMocks();
  });

  it('returns DOI when unpdf successfully extracts text containing a DOI', async () => {
    const fakeProxy = { numPages: 10 };
    unpdfMock.getDocumentProxy.mockResolvedValue(fakeProxy);
    unpdfMock.getMeta.mockResolvedValue({ info: {} });
    unpdfMock.extractText.mockResolvedValue({
      text: 'Title: Attention Is All You Need\nDOI: 10.48550/arXiv.1706.03762\nAbstract...',
    });

    const buf = Buffer.from('%PDF-1.4 fake compressed content');
    const doi = await extractor.extractFromBuffer(buf);

    expect(doi).toBe('10.48550/arXiv.1706.03762');
    expect(unpdfMock.getDocumentProxy).toHaveBeenCalled();
    expect(unpdfMock.extractText).toHaveBeenCalledWith(fakeProxy, {
      mergePages: true,
    });
  });

  it('falls back to raw byte scan when unpdf throws (encrypted PDF)', async () => {
    unpdfMock.getDocumentProxy.mockRejectedValue(new Error('PDF is encrypted'));

    // Raw bytes contain a plain-text DOI (simulates PDF with uncompressed header)
    const rawText = 'DOI: 10.1145/3377325.3377498 and other content';
    const buf = Buffer.from(rawText, 'latin1');

    const doi = await extractor.extractFromBuffer(buf);

    expect(doi).toBe('10.1145/3377325.3377498');
    expect(unpdfMock.getDocumentProxy).toHaveBeenCalled();
  });

  it('falls back to raw byte scan when unpdf returns empty text', async () => {
    const fakeProxy = { numPages: 3 };
    unpdfMock.getDocumentProxy.mockResolvedValue(fakeProxy);
    unpdfMock.getMeta.mockResolvedValue({ info: {} });
    unpdfMock.extractText.mockResolvedValue({ text: '' });

    // Raw bytes contain a DOI
    const rawText = '10.1038/s41586-021-03819-2 some header';
    const buf = Buffer.from(rawText, 'latin1');

    const doi = await extractor.extractFromBuffer(buf);
    // Raw scan should pick up the DOI from the bytes
    expect(doi).toBe('10.1038/s41586-021-03819-2');
  });

  it('returns null when unpdf extracts text but no DOI is present', async () => {
    const fakeProxy = { numPages: 5 };
    unpdfMock.getDocumentProxy.mockResolvedValue(fakeProxy);
    unpdfMock.getMeta.mockResolvedValue({ info: {} });
    unpdfMock.extractText.mockResolvedValue({
      text: 'This is a long paper about quantum mechanics without any identifier. '.repeat(
        5,
      ),
    });

    const buf = Buffer.from('%PDF-1.4 fake content');
    const doi = await extractor.extractFromBuffer(buf);

    expect(doi).toBeNull();
  });

  it('returns null when unpdf throws AND raw scan finds no DOI', async () => {
    unpdfMock.getDocumentProxy.mockRejectedValue(new Error('Corrupt PDF'));

    const buf = Buffer.from(
      'completely unrelated binary content without any doi',
    );
    const doi = await extractor.extractFromBuffer(buf);

    expect(doi).toBeNull();
  });
});
