import * as zlib from 'zlib';
import {
  buildZipArchive,
  sanitizeZipPath,
  toDosDateTime,
} from '../../src/modules/document/export/utils/zip-builder.util';

describe('ZipBuilderUtil', () => {
  describe('sanitizeZipPath', () => {
    it('normalizes backslashes to forward slashes', () => {
      expect(sanitizeZipPath('figures\\charts\\plot.png')).toBe(
        'figures/charts/plot.png',
      );
    });

    it('strips leading slashes and relative prefixes', () => {
      expect(sanitizeZipPath('./main.tex')).toBe('main.tex');
      expect(sanitizeZipPath('/src/main.tex')).toBe('src/main.tex');
      expect(sanitizeZipPath('///figures/logo.png')).toBe('figures/logo.png');
    });
  });

  describe('toDosDateTime', () => {
    it('encodes date and time into 16-bit MS-DOS format', () => {
      const date = new Date(2025, 0, 15, 14, 30, 10); // 2025-01-15 14:30:10
      const { time, date: dosDate } = toDosDateTime(date);

      expect(time).toBeGreaterThan(0);
      expect(dosDate).toBeGreaterThan(0);

      // Verify year offset (2025 - 1980 = 45)
      const year = (dosDate >> 9) + 1980;
      expect(year).toBe(2025);

      // Verify month (1)
      const month = (dosDate >> 5) & 0x0f;
      expect(month).toBe(1);

      // Verify day (15)
      const day = dosDate & 0x1f;
      expect(day).toBe(15);
    });
  });

  describe('buildZipArchive', () => {
    it('produces a valid ZIP archive containing text files', () => {
      const files = [
        {
          path: 'main.tex',
          data: '\\documentclass{article}\\begin{document}Hello Flux!\\end{document}',
        },
        {
          path: 'references.bib',
          data: '@article{test, title={Test Paper}}\n',
        },
      ];

      const zipBuffer = buildZipArchive(files);
      expect(zipBuffer).toBeInstanceOf(Buffer);
      expect(zipBuffer.length).toBeGreaterThan(0);

      // Verify PKZIP local header signature at offset 0
      expect(zipBuffer.readUInt32LE(0)).toBe(0x04034b50);

      // Verify End of Central Directory signature exists near the end
      const eocdSig = zipBuffer.indexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
      expect(eocdSig).toBeGreaterThan(0);

      // Total entries in EOCD (offset eocdSig + 10)
      const totalEntries = zipBuffer.readUInt16LE(eocdSig + 10);
      expect(totalEntries).toBe(2);
    });

    it('correctly handles binary buffer entries and empty files', () => {
      const binaryData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const files = [
        { path: 'images/figure1.png', data: binaryData },
        { path: 'empty.txt', data: '' },
      ];

      const zipBuffer = buildZipArchive(files);
      expect(zipBuffer.length).toBeGreaterThan(0);

      const eocdSig = zipBuffer.indexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
      expect(eocdSig).toBeGreaterThan(0);
      expect(zipBuffer.readUInt16LE(eocdSig + 10)).toBe(2);
    });

    it('verifies compressed data can be decompressed and matches raw input', () => {
      const originalContent = 'Sample LaTeX source content with multiple repeated words for compression.'.repeat(10);
      const files = [{ path: 'chapter1.tex', data: originalContent }];

      const zipBuffer = buildZipArchive(files);

      // Read local header fields
      const filenameLen = zipBuffer.readUInt16LE(26);
      const extraLen = zipBuffer.readUInt16LE(28);
      const compressedSize = zipBuffer.readUInt32LE(18);

      const dataStart = 30 + filenameLen + extraLen;
      const compressedPayload = zipBuffer.subarray(dataStart, dataStart + compressedSize);

      const decompressed = zlib.inflateRawSync(compressedPayload).toString('utf8');
      expect(decompressed).toBe(originalContent);
    });
  });
});
