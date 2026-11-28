import { Readable } from 'node:stream';
import { fromPartial } from '@total-typescript/shoehorn';
import sharp from 'sharp';
import { MAX_PDF_THUMBNAIL_BYTES } from '@/modules/files/files.constant';
import { ContentHash, StorageKey } from '@/modules/files/domain/storage.vo';
import { FilesFacade } from '@/modules/files/files.facade';
import { BlobRepository } from '@/modules/files/repositories/blob.repository';
import { QuotaRepository } from '@/modules/files/repositories/quota.repository';
import { BlobService } from '@/modules/files/services/blob.service';
import { ThumbnailService } from '@/modules/files/services/thumbnail.service';
import { FilesUploadService } from '@/modules/files/services/upload.service';
import type { IStorageAdapter } from '@/modules/files/types/adapter.type';
import { BlobStatus, type StorageBlobRecord } from '@/modules/files/types/files.type';

jest.mock('unpdf', () => ({
  renderPageAsImage: jest.fn(async (buffer: Buffer, _page: number) => {
    if (
      !buffer ||
      buffer.length === 0 ||
      Buffer.from(buffer).toString().includes('not-a-valid-pdf')
    ) {
      throw new Error('Invalid PDF binary stream');
    }
    return await sharp({
      create: {
        width: 600,
        height: 800,
        channels: 4,
        background: { r: 240, g: 240, b: 240, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
  }),
}));

function makeBlob(
  id: string,
  contentHashHex: string,
  sizeBytes: bigint,
): StorageBlobRecord {
  return {
    id,
    contentHashHex,
    hashAlgorithm: 'SHA256',
    sizeBytes,
    mimeType: 'application/pdf',
    checksumVerified: true,
    s3Key: StorageKey.forBlob(contentHashHex).value(),
    s3Bucket: 'flux',
    storageClass: 'STANDARD',
    refCount: 1,
    status: BlobStatus.READY,
    createdAt: new Date(),
    tombstoneAt: null,
    claimedAt: null,
  };
}

describe('ThumbnailService & FilesFacade PDF Thumbnail Guard', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('ThumbnailService.generateThumbnail', () => {
    it('renders a valid 1-page PDF into a WebP thumbnail buffer and respects custom dimensions', async () => {
      const service = new ThumbnailService();
      const mockPdfBuffer = Buffer.from('%PDF-1.4 mock paper binary stream');

      const defaultThumb = await service.generateThumbnail(mockPdfBuffer);
      expect(defaultThumb).not.toBeNull();
      const defaultMeta = await sharp(defaultThumb!).metadata();
      expect(defaultMeta.format).toBe('webp');
      expect(defaultMeta.width).toBeLessThanOrEqual(300);
      expect(defaultMeta.height).toBeLessThanOrEqual(420);

      const customThumb = await service.generateThumbnail(mockPdfBuffer, {
        width: 150,
        height: 200,
        quality: 60,
      });
      expect(customThumb).not.toBeNull();
      const customMeta = await sharp(customThumb!).metadata();
      expect(customMeta.format).toBe('webp');
      expect(customMeta.width).toBeLessThanOrEqual(150);
      expect(customMeta.height).toBeLessThanOrEqual(200);
    });

    it('returns null gracefully for empty or corrupt PDF buffers without throwing', async () => {
      const service = new ThumbnailService();

      await expect(
        service.generateThumbnail(Buffer.alloc(0)),
      ).resolves.toBeNull();
      await expect(
        service.generateThumbnail(Buffer.from('not-a-valid-pdf-header-content')),
      ).resolves.toBeNull();
    });
  });

  describe('FilesFacade.ensurePdfThumbnail RAM Guard & Singleflight', () => {
    it('skips streaming for PDFs exceeding 25 MB and caches derivatives for smaller PDFs', async () => {
      const hashSmall = ContentHash.fromBuffer(Buffer.from('small-pdf')).toHex();
      const hashBig = ContentHash.fromBuffer(Buffer.from('big-pdf')).toHex();
      const smallBlob = makeBlob('blob-small-pdf', hashSmall, 1024n);
      const bigBlob = makeBlob(
        'blob-huge-pdf',
        hashBig,
        MAX_PDF_THUMBNAIL_BYTES + 1n,
      );

      const pdfPayload = Buffer.from('%PDF-1.7 sample');
      const getStream = jest.fn().mockResolvedValue({
        stream: Readable.from([pdfPayload]),
        contentLength: pdfPayload.length,
      });
      const put = jest.fn().mockResolvedValue(undefined);
      const adapter = fromPartial<IStorageAdapter>({
        exists: jest.fn().mockResolvedValue(false),
        getStream,
        put,
      });

      const blobRepo = fromPartial<BlobRepository>({
        findById: jest.fn(async (id: string) => {
          if (id === smallBlob.id) return smallBlob;
          if (id === bigBlob.id) return bigBlob;
          return null;
        }),
      });

      const blobService = new BlobService(adapter, blobRepo);
      const thumbnailService = new ThumbnailService(
        adapter,
        blobRepo,
        blobService,
      );
      const renderedWebp = Buffer.from('webp-thumb-bytes');
      const genSpy = jest
        .spyOn(thumbnailService, 'generateThumbnail')
        .mockResolvedValue(renderedWebp);

      const facade = new FilesFacade(
        adapter,
        blobService,
        blobRepo,
        fromPartial<QuotaRepository>({}),
        fromPartial<FilesUploadService>({}),
        thumbnailService,
      );

      await expect(
        facade.ensurePdfThumbnail({ fileId: bigBlob.id }),
      ).resolves.toBeNull();
      expect(getStream).not.toHaveBeenCalled();

      await expect(
        facade.ensurePdfThumbnail({ fileId: smallBlob.id }),
      ).resolves.toEqual(renderedWebp);
      expect(genSpy).toHaveBeenCalledWith(pdfPayload);
      expect(put).toHaveBeenCalledWith(
        StorageKey.forDerivative(hashSmall, 'thumb').value(),
        renderedWebp,
        { mimeType: 'image/webp', size: renderedWebp.length },
      );
    });

    it('coalesces concurrent ensurePdfThumbnail requests for the same blob via singleflight lock', async () => {
      const hashHex = ContentHash.fromBuffer(
        Buffer.from('concurrent-pdf'),
      ).toHex();
      const blob = makeBlob('blob-singleflight', hashHex, 1024n);
      const pdfPayload = Buffer.from('%PDF-1.7 concurrent');

      const put = jest.fn().mockResolvedValue(undefined);
      const adapter = fromPartial<IStorageAdapter>({
        exists: jest.fn().mockResolvedValue(false),
        getStream: jest.fn(async () => ({
          stream: Readable.from([pdfPayload]),
          contentLength: pdfPayload.length,
        })),
        put,
      });
      const blobRepo = fromPartial<BlobRepository>({
        findById: jest.fn().mockResolvedValue(blob),
      });

      const blobService = new BlobService(adapter, blobRepo);
      const thumbService = new ThumbnailService(adapter, blobRepo, blobService);
      const renderedWebp = Buffer.from('singleflight-webp');
      const genSpy = jest
        .spyOn(thumbService, 'generateThumbnail')
        .mockImplementation(async () => {
          await new Promise((r) => setTimeout(r, 15));
          return renderedWebp;
        });

      const facade = new FilesFacade(
        adapter,
        blobService,
        blobRepo,
        fromPartial<QuotaRepository>({}),
        fromPartial<FilesUploadService>({}),
        thumbService,
      );

      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          facade.ensurePdfThumbnail({ fileId: blob.id }),
        ),
      );

      expect(results).toEqual(Array.from({ length: 5 }, () => renderedWebp));
      expect(genSpy).toHaveBeenCalledTimes(1);
      expect(put).toHaveBeenCalledTimes(1);
    });
  });
});
