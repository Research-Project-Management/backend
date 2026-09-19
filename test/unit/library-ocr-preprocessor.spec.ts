import { OcrPreprocessorService } from '../../src/modules/library/attachments/ocr/ocr-preprocessor.service';
import { createCanvas } from '@napi-rs/canvas';
import sharp from 'sharp';

describe('OcrPreprocessorService', () => {
  let service: OcrPreprocessorService;

  beforeEach(() => {
    service = new OcrPreprocessorService();
  });

  it('preprocesses an image buffer with grayscale, normalization, and binarization', async () => {
    // Create synthetic text image
    const canvas = createCanvas(400, 200);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 400, 200);
    ctx.fillStyle = '#000000';
    ctx.font = '24px Arial';
    ctx.fillText('Sample Research Paper Header', 20, 60);
    ctx.fillText('Autonomous Agentic OCR Subsystem', 20, 110);

    const inputBuffer = canvas.toBuffer('image/png');
    const result = await service.preprocess(inputBuffer, {
      autoRotate: false,
      deskew: false,
      contrastEnhance: true,
      denoise: true,
      binarize: true,
    });

    expect(result).toBeDefined();
    expect(result.buffer).toBeInstanceOf(Buffer);
    expect(result.width).toBe(400);
    expect(result.height).toBe(200);

    const meta = await sharp(result.buffer).metadata();
    expect(meta.format).toBe('png');
    expect(meta.width).toBe(400);
    expect(meta.height).toBe(200);
  });

  it('estimates deskew angle on horizontal text lines', async () => {
    const canvas = createCanvas(500, 300);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 500, 300);
    ctx.fillStyle = '#000000';
    ctx.font = '20px Arial';

    for (let i = 0; i < 6; i++) {
      ctx.fillText(
        `Text line number ${i + 1} with horizontal alignment`,
        20,
        40 + i * 35,
      );
    }

    const inputBuffer = canvas.toBuffer('image/png');
    const detectedAngle = await service.estimateDeskewAngle(
      inputBuffer,
      -5,
      5,
      1,
    );

    // Perfectly horizontal text should have deskew angle close to 0
    expect(Math.abs(detectedAngle)).toBeLessThanOrEqual(1);
  });
});
