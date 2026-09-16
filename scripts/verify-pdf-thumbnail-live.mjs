import { PDFDocument, rgb } from 'pdf-lib';
import sharp from 'sharp';
import { renderPageAsImage } from 'unpdf';

async function run() {
  console.log('--- Real-world In-Process PDF Thumbnail Verification ---');

  // 1. Generate a real PDF document
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595, 842]); // A4
  page.drawText('Flux Paper: Quantum Machine Learning (2026)', {
    x: 50,
    y: 750,
    size: 22,
    color: rgb(0.1, 0.2, 0.6),
  });
  page.drawText('Authors: Antigravity Pairing Assistant', {
    x: 50,
    y: 710,
    size: 14,
    color: rgb(0.3, 0.3, 0.3),
  });
  const pdfBytes = await pdfDoc.save();
  const pdfBuffer = Buffer.from(pdfBytes);
  console.log(`Generated sample PDF in-memory: ${pdfBuffer.length} bytes`);

  // 2. Render Page 1 via unpdf + @napi-rs/canvas
  const start = performance.now();
  const uint8Data = new Uint8Array(pdfBuffer.buffer, pdfBuffer.byteOffset, pdfBuffer.byteLength);
  const pageImageBuffer = await renderPageAsImage(uint8Data, 1, {
    canvasImport: () => import('@napi-rs/canvas'),
  });
  console.log(`Rendered page 1 raw canvas buffer: ${pageImageBuffer.byteLength} bytes in ${(performance.now() - start).toFixed(1)}ms`);

  // 3. Compress to WebP via sharp
  const startCompress = performance.now();
  const webpBuffer = await sharp(Buffer.from(pageImageBuffer))
    .resize(300, 420, {
      fit: 'cover',
      position: 'top',
      withoutEnlargement: true,
    })
    .webp({ quality: 80, effort: 4 })
    .toBuffer();

  const meta = await sharp(webpBuffer).metadata();
  console.log(`Compressed to WebP: ${webpBuffer.length} bytes (${meta.width}x${meta.height}, format: ${meta.format}) in ${(performance.now() - startCompress).toFixed(1)}ms`);

  if (meta.format === 'webp' && meta.width <= 300 && meta.height <= 420 && webpBuffer.length > 0) {
    console.log('>>> [SUCCESS] 100% In-Process PDF Cover & Thumbnail Generation VERIFIED!');
    process.exit(0);
  } else {
    console.error('>>> [FAILED] Metadata mismatch');
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('>>> [ERROR]:', err);
  process.exit(1);
});
