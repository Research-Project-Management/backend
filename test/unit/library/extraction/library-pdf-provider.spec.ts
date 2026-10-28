import { getDocumentProxy, getMeta } from 'unpdf';
import { PdfProvider } from '@/modules/library/extraction/providers/pdf.provider';
import { PdfTextMetadataExtractor } from '@/modules/library/extraction/providers/pdf-text-metadata.extractor';
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

  it('uses OCR when a page has no usable text layer', async () => {
    mockedGetMeta.mockResolvedValue({ info: {} });
    const page = {
      getTextContent: jest.fn().mockResolvedValue({ items: [] }),
    };
    mockedGetDocumentProxy.mockResolvedValue({
      numPages: 1,
      getPage: jest.fn().mockResolvedValue(page),
    });
    const ocr = {
      enabled: true,
      maxPages: 50,
      recognizePdfPage: jest
        .fn()
        .mockResolvedValue('Scanned article text from OCR'),
    };

    const provider = new PdfProvider(ocr as any);
    const result = await provider.extractDocumentFromBuffer(
      Buffer.from('%PDF scan'),
    );

    expect(ocr.recognizePdfPage).toHaveBeenCalledWith(page, 0);
    expect(result.pages[0].textContent).toBe('Scanned article text from OCR');
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

    const provider = new PdfProvider(undefined, trustedExtractor as never);
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
});
