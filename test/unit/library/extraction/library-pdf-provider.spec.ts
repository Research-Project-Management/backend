import { getDocumentProxy, getMeta } from 'unpdf';
import { PdfProvider } from '@/modules/library/extraction/providers/pdf.provider';
import { PdfTextMetadataExtractor } from '@/modules/library/extraction/providers/pdf-text-metadata.extractor';
import { LayoutExtractor } from '@/modules/library/extraction/extractors/layout.extractor';
import { PdfMetadataExtractor } from '@/modules/library/extraction/services/pdf-metadata.extractor';
import { ExtractionMetadataSynchronizer } from '@/modules/library/extraction/services/extraction-metadata.synchronizer';
import { ExtractionRepository } from '@/modules/library/extraction/repositories/extraction.repository';

jest.mock('unpdf', () => ({
  extractText: jest.fn(),
  getDocumentProxy: jest.fn(),
  getMeta: jest.fn(),
}));

describe('PdfProvider', () => {
  const mockedGetDocumentProxy = getDocumentProxy as jest.Mock;
  const mockedGetMeta = getMeta as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.PDF_MAX_INDEX_PAGES;
  });

  it('indexes every page by default instead of truncating after page 25', async () => {
    mockedGetMeta.mockResolvedValue({ info: {} });
    mockedGetDocumentProxy.mockResolvedValue({
      numPages: 30,
      getPage: jest.fn(async (pageNumber: number) => ({
        getTextContent: jest.fn().mockResolvedValue({
          items: [
            {
              str: `Page ${pageNumber} contains enough searchable text for indexing.`,
            },
          ],
        }),
      })),
    });

    const provider = new PdfProvider();
    const result = await provider.extractDocumentFromBuffer(
      Buffer.from('%PDF fixture'),
    );

    expect(result.pages).toHaveLength(30);
    expect(result.pages[29].textContent).toContain('Page 30');
  });

  it('keeps header-only identification bounded to the first three pages', async () => {
    mockedGetMeta.mockResolvedValue({ info: {} });
    const getPage = jest.fn(async () => ({
      getTextContent: jest.fn().mockResolvedValue({
        items: [{ str: 'A sufficiently long page of bibliographic text.' }],
      }),
    }));
    mockedGetDocumentProxy.mockResolvedValue({ numPages: 20, getPage });

    const provider = new PdfProvider();
    const result = await provider.extractDocumentFromBuffer(
      Buffer.from('%PDF fixture'),
      { headerOnly: true },
    );

    expect(result.pages).toHaveLength(3);
    expect(getPage).toHaveBeenCalledTimes(3);
  });

  it('skips duplicate trustedExtractor.extract when skipTrustedExtraction is true', async () => {
    mockedGetMeta.mockResolvedValue({ info: { Title: 'Header Extracted Paper Title' } });
    mockedGetDocumentProxy.mockResolvedValue({
      numPages: 2,
      getPage: jest.fn(async () => ({
        getTextContent: jest.fn().mockResolvedValue({
          items: [{ str: 'Header text content' }],
        }),
      })),
    });
    const trustedExtractor = {
      extract: jest.fn(),
    };

    const provider = new PdfProvider(trustedExtractor as never);
    const result = await provider.extractDocumentFromBuffer(
      Buffer.from('%PDF fixture'),
      { headerOnly: true, skipTrustedExtraction: true },
    );

    expect(trustedExtractor.extract).not.toHaveBeenCalled();
    expect(result.metadata.title).toBe('Header Extracted Paper Title');
  });

  describe('PdfTextMetadataExtractor (TOC & Citation Disambiguation)', () => {
    it('does not truncate frontMatter at TOC References lines and disambiguates cited DOIs', () => {
      const extractor = new PdfTextMetadataExtractor();
      const textWithToc = [
        'Table of Contents',
        '1. Introduction ................ 1',
        '2. Methodology ................. 12',
        'References ..................... 42',
        '',
        'Prior work by Smith et al. [1] (10.1145/1111111) explored linear models.',
        'DOI: 10.1038/s41586-024-08888-9',
        'ISBN: 978-0-262-03384-8',
        'ISSN: 0028-0836',
        'PMID: 38123456',
        '',
        'References',
        '[1] J. Smith, 10.1145/9999999, ISBN 978-0-13-110362-7',
      ].join('\n');

      expect(extractor.extractFromText(textWithToc)).toBe(
        '10.1038/s41586-024-08888-9',
      );
      const meta = extractor.extractMetadataFromText(textWithToc);
      expect(meta.doi).toBe('10.1038/s41586-024-08888-9');
      expect(meta.isbn).toBe('9780262033848');
      expect(meta.issn).toBe('0028-0836');
      expect(meta.pmid).toBe('38123456');
    });
  });

  describe('ExtractionMetadataSynchronizer & ExtractionRepository Provenance Guards', () => {
    it('does not downgrade journalArticle to preprint when item has publisher DOI or CrossRef itemType provenance', () => {
      const repo = new ExtractionRepository({} as never);
      const sync = new ExtractionMetadataSynchronizer(repo);

      const planWithPublisherDoi = sync.buildMetadataSyncPlan(
        {
          id: 'att-1',
          itemId: 'item-1',
          item: {
            id: 'item-1',
            itemType: 'journalArticle',
            doi: '10.1038/s41586-020-2649-2',
            title: 'Published Nature Paper',
            metadata: {},
          },
        },
        {
          metadata: {
            arxivId: '2005.14165',
            title: 'Published Nature Paper',
          },
        },
      );
      expect(planWithPublisherDoi.itemPatch.itemType).toBeUndefined();
      expect(planWithPublisherDoi.metaPatch.itemType).toBeUndefined();

      const planWithCrossRefProvenance = sync.buildMetadataSyncPlan(
        {
          id: 'att-2',
          itemId: 'item-2',
          item: {
            id: 'item-2',
            itemType: 'journalArticle',
            title: 'CrossRef Authoritative Article',
            metadata: {
              fieldProvenance: {
                itemType: {
                  source: 'CrossRef',
                  sourceProvider: 'CrossRef',
                  confidence: 0.95,
                },
              },
            },
          },
        },
        {
          metadata: {
            arxivId: '2303.08774',
            title: 'CrossRef Authoritative Article',
          },
        },
      );
      expect(planWithCrossRefProvenance.itemPatch.itemType).toBeUndefined();
      expect(planWithCrossRefProvenance.metaPatch.itemType).toBeUndefined();
    });

    it('protects coupled fields (journal -> publicationTitle, date -> year) and higher-authority itemType in ExtractionRepository', async () => {
      const mockPrisma = {
        item: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'item-locked-1',
            userId: 'user-1',
            projectId: null,
            title: 'Existing Title',
            doi: null,
            abstract: null,
            year: null,
            publicationTitle: null,
            itemType: 'journalArticle',
            citationKey: 'smith2024existing',
            metadata: {
              lockedFields: ['journal', 'date'],
              fieldProvenance: {
                itemType: {
                  source: 'CrossRef',
                  sourceProvider: 'CrossRef',
                  confidence: 0.95,
                },
              },
            },
          }),
          update: jest.fn().mockImplementation(async ({ data }) => ({
            id: 'item-locked-1',
            ...data,
          })),
        },
      };

      const repo = new ExtractionRepository(mockPrisma as never);
      await repo.updateItemWithExtractedMetadata('item-locked-1', {
        year: 2021,
        publicationTitle: 'Extracted Venue',
        itemType: 'preprint',
        metadata: {
          publicationTitle: 'Extracted Venue',
          publicationDate: '2021-01-01',
          itemType: 'preprint',
        },
      });

      const updateCall = mockPrisma.item.update.mock.calls[0][0];
      expect(updateCall.data.year).toBeUndefined();
      expect(updateCall.data.publicationTitle).toBeUndefined();
      expect(updateCall.data.itemType).toBeUndefined();
      expect(updateCall.data.metadata.publicationTitle).toBeUndefined();
      expect(updateCall.data.metadata.publicationDate).toBeUndefined();
      expect(updateCall.data.metadata.itemType).toBeUndefined();
    });

    it('caps inline plainText and markdown at 100,000 chars when storage offload fails', async () => {
      const saveMetadataSourceRecord = jest
        .fn()
        .mockResolvedValue({ id: 'rec-1', supersededFileIds: [] });
      const mockRepo = {
        saveMetadataSourceRecord,
        countContributors: jest.fn().mockResolvedValue(1),
        countItemTags: jest.fn().mockResolvedValue(1),
        countItemNotes: jest.fn().mockResolvedValue(1),
        updateItem: jest.fn().mockResolvedValue({ id: 'item-1', version: 2 }),
      } as unknown as ExtractionRepository;
      const failingStorage = {
        uploadFile: jest.fn().mockRejectedValue(new Error('S3 offline')),
      };

      const sync = new ExtractionMetadataSynchronizer(
        mockRepo,
        undefined,
        failingStorage as never,
      );
      const hugeText = 'A'.repeat(150_000);
      const hugeMarkdown = 'B'.repeat(140_000);

      await sync.offloadFullTextAndSyncMetadata(
        {
          id: 'att-huge',
          itemId: 'item-1',
          item: { id: 'item-1', userId: 'user-1', title: 'Valid Title' },
        },
        {
          fullText: hugeText,
          metadata: { title: 'Valid Title' },
        },
        {
          text: hugeText,
          markdown: hugeMarkdown,
        },
      );

      expect(saveMetadataSourceRecord).toHaveBeenCalledWith(
        'item-1',
        'pdf_fulltext',
        expect.objectContaining({
          plainText: 'A'.repeat(100_000),
          markdown: 'B'.repeat(100_000),
        }),
      );
    });
  });

  describe('Zotero recognizePDF Parity (Pre-OCR Sandwich PDF Text Layer & Un-OCR Scanned PDF Handling)', () => {
    it('extracts Title, Authors, and DOI from a pre-OCR Sandwich PDF text layer via PDF.js getTextContent() and leaves pure un-OCR scanned PDFs with filename fallback', async () => {
      const sandwichTextItems = [
        {
          str: 'DOI: 10.1038/s41586-025-09999-z',
          transform: [10, 0, 0, 10, 50, 740],
          hasEOL: true,
        },
        {
          str: 'Geometric Deep Learning on Scanned Scientific Manuscripts',
          transform: [22, 0, 0, 22, 50, 680],
          hasEOL: true,
        },
        {
          str: 'Minh Hoang Nguyen, Elena Rostova',
          transform: [12, 0, 0, 12, 50, 640],
          hasEOL: true,
        },
        {
          str: 'Abstract—We study geometric layout extraction on pre-OCR sandwich PDFs via standard PDF.js text items.',
          transform: [10, 0, 0, 10, 50, 590],
          hasEOL: true,
        },
      ];

      const layoutFields =
        LayoutExtractor.extractFromRawItems(sandwichTextItems);
      expect(layoutFields.title).toBe(
        'Geometric Deep Learning on Scanned Scientific Manuscripts',
      );
      expect(layoutFields.authors).toEqual([
        'Minh Hoang Nguyen',
        'Elena Rostova',
      ]);
      expect(layoutFields.abstract).toContain('pre-OCR sandwich PDFs');
      expect(layoutFields.maxFontSize).toBeCloseTo(22, 0);

      const sandwichDocProxy = {
        numPages: 1,
        getPage: jest.fn().mockResolvedValue({
          cleanup: jest.fn(),
          getTextContent: jest.fn().mockResolvedValue({
            items: sandwichTextItems,
          }),
        }),
      };

      const extractor = new PdfMetadataExtractor();
      const sandwichResult = await extractor.extract(
        Buffer.from('%PDF-1.7 sandwich'),
        'scan_001.pdf',
        sandwichDocProxy as never,
      );

      expect(sandwichResult.metadata.doi).toBe('10.1038/s41586-025-09999-z');
      expect(sandwichResult.metadata.title).toBe(
        'Geometric Deep Learning on Scanned Scientific Manuscripts',
      );
      expect(sandwichResult.metadata.authors).toEqual([
        'Minh Hoang Nguyen',
        'Elena Rostova',
      ]);

      const pureScannedDocProxy = {
        numPages: 1,
        getPage: jest.fn().mockResolvedValue({
          cleanup: jest.fn(),
          getTextContent: jest.fn().mockResolvedValue({ items: [] }),
        }),
      };
      const pureScannedResult = await extractor.extract(
        Buffer.from('%PDF-1.7 pure-scan'),
        'scan_001.pdf',
        pureScannedDocProxy as never,
      );
      expect(pureScannedResult.metadata.doi).toBeUndefined();
      expect(pureScannedResult.metadata.title).toBe('scan 001');
      expect(pureScannedResult.provenance.rawMatches?.titleFromFilename).toBe(
        true,
      );
    });

    it('strips repeated running headers and footers across multi-page front matter', () => {
      const page1 = [
        'ACM Transactions on Information Systems — Page 1',
        'Scalable Hybrid Retrieval With Neural Sparse Representations',
        'David Park, Lin Chen',
        'Abstract—We study sparse-dense hybrid retrieval models.',
        'Copyright 2025 ACM — Page 1 of 18',
      ].join('\n');

      const page2 = [
        'ACM Transactions on Information Systems — Page 2',
        '1. Introduction',
        'Hybrid retrieval combines lexical and semantic matching.',
        'Copyright 2025 ACM — Page 2 of 18',
      ].join('\n');

      const stripped =
        LayoutExtractor.stripRunningHeadersAndFootersFromText([
          page1,
          page2,
        ]);

      expect(stripped.signatures.size).toBeGreaterThanOrEqual(2);
      expect(stripped.cleanedText).not.toContain(
        'ACM Transactions on Information Systems — Page 1',
      );
      expect(stripped.cleanedText).not.toContain('Page 1 of 18');
      expect(stripped.cleanedText).toContain(
        'Scalable Hybrid Retrieval With Neural Sparse Representations',
      );
    });
  });
});
