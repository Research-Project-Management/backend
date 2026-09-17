import sharp from 'sharp';
import { PdfThumbnailService } from '../../src/modules/storage/application/services/pdf-thumbnail.service';

jest.mock('unpdf', () => ({
  renderPageAsImage: jest.fn(async (buffer: Buffer, _page: number) => {
    if (
      !buffer ||
      buffer.length === 0 ||
      Buffer.from(buffer).toString().includes('not-a-valid-pdf')
    ) {
      throw new Error('Invalid PDF binary stream');
    }
    // Return a mock rendered canvas image buffer (600x800 raw PNG)
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

describe('PdfThumbnailService', () => {
  let service: PdfThumbnailService;

  beforeEach(() => {
    service = new PdfThumbnailService();
  });

  it('should render a valid 1-page PDF into a WebP thumbnail buffer', async () => {
    const mockPdfBuffer = Buffer.from('%PDF-1.4 mock paper binary stream');

    const thumbBuffer = await service.generateThumbnail(mockPdfBuffer);

    expect(thumbBuffer).toBeDefined();
    expect(thumbBuffer).not.toBeNull();
    expect(Buffer.isBuffer(thumbBuffer)).toBe(true);
    expect(thumbBuffer!.length).toBeGreaterThan(0);

    // Verify sharp metadata
    const meta = await sharp(thumbBuffer!).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBeLessThanOrEqual(300);
    expect(meta.height).toBeLessThanOrEqual(420);
  });

  it('should respect custom width, height, and quality options', async () => {
    const mockPdfBuffer = Buffer.from('%PDF-1.4 mock paper binary stream');

    const thumbBuffer = await service.generateThumbnail(mockPdfBuffer, {
      width: 150,
      height: 200,
      quality: 60,
    });

    expect(thumbBuffer).not.toBeNull();
    const meta = await sharp(thumbBuffer!).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBeLessThanOrEqual(150);
    expect(meta.height).toBeLessThanOrEqual(200);
  });

  it('should return null gracefully for empty or corrupt PDF buffers without throwing', async () => {
    const emptyResult = await service.generateThumbnail(Buffer.alloc(0));
    expect(emptyResult).toBeNull();

    const corruptResult = await service.generateThumbnail(
      Buffer.from('not-a-valid-pdf-header-content'),
    );
    expect(corruptResult).toBeNull();
  });
});
