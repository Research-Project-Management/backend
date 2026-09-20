jest.mock('unpdf', () => ({
  getDocumentProxy: jest.fn(),
}));

import { NotFoundException, BadRequestException } from '@nestjs/common';
import { PdfAnnotationImporterService } from '@/modules/library/reader/application/services/pdf-annotation-importer.service';
import { AnnotationType } from '@prisma/client';
import { getDocumentProxy } from 'unpdf';

describe('PdfAnnotationImporterService (Zotero 7 Level 5 PDF /Annots Import)', () => {
  let service: PdfAnnotationImporterService;
  let mockAnnotationsRepo: any;
  let mockAttachmentsRepo: any;
  let mockStoragePort: any;
  let mockAnnotationsService: any;
  const mockGetDocumentProxy = getDocumentProxy as jest.MockedFunction<
    typeof getDocumentProxy
  >;

  beforeEach(() => {
    jest.clearAllMocks();

    mockAnnotationsRepo = {
      findExistingForImport: jest.fn().mockResolvedValue([]),
    };

    mockAttachmentsRepo = {
      findUnique: jest.fn(),
      checkProjectMember: jest.fn().mockResolvedValue(true),
    };

    mockStoragePort = {
      readOwnedFile: jest.fn(),
    };

    mockAnnotationsService = {
      getAnnotationsByAttachment: jest.fn().mockResolvedValue([]),
      createAnnotation: jest
        .fn()
        .mockImplementation((_userId, dto) =>
          Promise.resolve({ id: 'anno-created', ...dto }),
        ),
    };

    service = new PdfAnnotationImporterService(
      mockAnnotationsRepo,
      mockAttachmentsRepo,
      mockStoragePort,
      mockAnnotationsService,
    );
  });

  it('should throw NotFoundException if attachment is not found', async () => {
    mockAttachmentsRepo.findUnique.mockResolvedValue(null);

    await expect(
      service.importFromAttachment('user-1', 'missing-att'),
    ).rejects.toThrow(NotFoundException);
  });

  it('should throw BadRequestException if attachment has no physical file in storage', async () => {
    mockAttachmentsRepo.findUnique.mockResolvedValue({
      id: 'att-1',
      fileId: null,
      file: null,
    });

    await expect(
      service.importFromAttachment('user-1', 'att-1'),
    ).rejects.toThrow(BadRequestException);
  });

  it('should return 0 imported when PDF contains no annotations', async () => {
    mockAttachmentsRepo.findUnique.mockResolvedValue({
      id: 'att-1',
      fileId: 'file-100',
    });

    mockStoragePort.readOwnedFile.mockResolvedValue({
      buffer: Buffer.from('%PDF-1.4 mock pdf'),
    });

    const mockPdfDoc = {
      numPages: 1,
      getPage: jest.fn().mockResolvedValue({
        getViewport: jest.fn().mockReturnValue({ width: 600, height: 800 }),
        getAnnotations: jest.fn().mockResolvedValue([]),
      }),
    };
    mockGetDocumentProxy.mockResolvedValue(mockPdfDoc as any);

    const result = await service.importFromAttachment('user-1', 'att-1');

    expect(result).toEqual({
      imported: 0,
      totalFound: 0,
      pagesScanned: 1,
    });
    expect(mockAnnotationsService.createAnnotation).not.toHaveBeenCalled();
  });

  it('should convert standard PDF Annots (Highlight, Underline, StrikeOut, FreeText) and persist them', async () => {
    mockAttachmentsRepo.findUnique.mockResolvedValue({
      id: 'att-1',
      fileId: 'file-100',
    });

    mockStoragePort.readOwnedFile.mockResolvedValue({
      buffer: Buffer.from('%PDF-1.4 mock with annots'),
    });

    // Mock PDF page with 2 annotations: 1 highlight and 1 strikeout
    const mockPdfDoc = {
      numPages: 1,
      getPage: jest.fn().mockResolvedValue({
        getViewport: jest.fn().mockReturnValue({ width: 500, height: 1000 }),
        getAnnotations: jest.fn().mockResolvedValue([
          {
            subtype: 'Highlight',
            rect: [50, 700, 250, 750], // bottom-left origin: x1=50, y1=700, x2=250, y2=750
            contents: 'Important research finding',
            color: [1, 0.83, 0], // #ffd400
          },
          {
            subtype: 'StrikeOut',
            rect: [50, 500, 300, 520],
            contents: 'Outdated hypothesis',
            color: [1, 0, 0], // #ff0000
          },
          {
            subtype: 'Link', // Unsupported non-markup subtype, should be skipped
            rect: [10, 10, 50, 50],
          },
        ]),
      }),
    };
    mockGetDocumentProxy.mockResolvedValue(mockPdfDoc as any);

    const result = await service.importFromAttachment('user-1', 'att-1');

    expect(result.totalFound).toBe(2);
    expect(result.imported).toBe(2);
    expect(result.pagesScanned).toBe(1);

    // Verify coordinate conversion:
    // Page height = 1000. For Highlight [50, 700, 250, 750]:
    // normX = 50 / 500 = 0.1
    // normY = (1000 - 750) / 1000 = 0.25
    // normWidth = (250 - 50) / 500 = 0.4
    // normHeight = (750 - 700) / 1000 = 0.05
    expect(mockAnnotationsService.createAnnotation).toHaveBeenCalledWith(
      'user-1',
      {
        attachmentId: 'att-1',
        type: AnnotationType.highlight,
        pageIndex: 0,
        y: 0.25,
        x: 0.1,
        quoteText: 'Important research finding',
        comment: '',
        color: '#ffd400',
        rectCoords: [
          {
            x1: 0.1,
            y1: 0.25,
            x2: 0.5,
            y2: 0.3,
            width: 0.4,
            height: 0.05,
          },
        ],
        authorId: 'user-1',
      },
    );

    // Verify StrikeOut conversion
    expect(mockAnnotationsService.createAnnotation).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        type: AnnotationType.strike,
        pageIndex: 0,
        quoteText: 'Outdated hypothesis',
        color: '#ff0000',
      }),
    );
  });

  it('should skip annotations that already exist (deduplication)', async () => {
    mockAttachmentsRepo.findUnique.mockResolvedValue({
      id: 'att-1',
      fileId: 'file-100',
    });

    mockStoragePort.readOwnedFile.mockResolvedValue({
      buffer: Buffer.from('%PDF-1.4 mock'),
    });

    const mockPdfDoc = {
      numPages: 1,
      getPage: jest.fn().mockResolvedValue({
        getViewport: jest.fn().mockReturnValue({ width: 500, height: 1000 }),
        getAnnotations: jest.fn().mockResolvedValue([
          {
            subtype: 'Highlight',
            rect: [50, 700, 250, 750], // y = (1000 - 750) / 1000 = 0.25, x = 0.1
            contents: 'Already exists in database',
          },
        ]),
      }),
    };
    mockGetDocumentProxy.mockResolvedValue(mockPdfDoc as any);

    // Existing annotation in database on pageIndex 0 with identical position
    mockAnnotationsRepo.findExistingForImport.mockResolvedValue([
      {
        pageIndex: 0,
        type: AnnotationType.highlight,
        rectCoords: [{ x1: 0.1, y1: 0.25 }],
      },
    ]);

    const result = await service.importFromAttachment('user-1', 'att-1');

    expect(result.totalFound).toBe(1);
    expect(result.imported).toBe(0); // Deduplicated!
    expect(mockAnnotationsService.createAnnotation).not.toHaveBeenCalled();
  });
});
