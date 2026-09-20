/**
 * zip-builder.util.ts
 *
 * Lightweight, zero-dependency PKZIP 2.0 generator utilizing Node.js built-in `zlib`.
 * Creates standards-compliant .zip archives compatible with Windows Explorer,
 * macOS Archive Utility, Linux unzip, Python zipfile, and arXiv / Overleaf ingestion.
 */

import * as zlib from 'zlib';

export interface ZipFileEntry {
  /** Relative file path within archive (e.g., 'main.tex', 'figures/chart.png') */
  path: string;
  /** Content either as UTF-8 string or binary Buffer */
  data: string | Buffer;
  /** Optional file modification timestamp */
  date?: Date;
}

/**
 * Converts JavaScript Date into standard MS-DOS 16-bit time and date bitfields.
 */
export function toDosDateTime(d: Date = new Date()): {
  time: number;
  date: number;
} {
  const year = Math.max(1980, d.getFullYear());
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const hours = d.getHours();
  const minutes = d.getMinutes();
  const seconds = Math.floor(d.getSeconds() / 2);

  const dosTime = (hours << 11) | (minutes << 5) | seconds;
  const dosDate = ((year - 1980) << 9) | (month << 5) | day;
  return { time: dosTime, date: dosDate };
}

/**
 * Sanitizes archive relative path to prevent directory traversal or invalid separators.
 */
export function sanitizeZipPath(rawPath: string): string {
  return rawPath
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .replace(/\/\.{1,2}\//g, '/')
    .replace(/^\/+/, '');
}

/**
 * Builds a valid PKZIP 2.0 archive in memory from the given file entries.
 */
export function buildZipArchive(entries: ZipFileEntry[]): Buffer {
  const localChunks: Buffer[] = [];
  const cdChunks: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const cleanPath = sanitizeZipPath(entry.path);
    if (!cleanPath) continue;

    const nameBuf = Buffer.from(cleanPath, 'utf8');
    const rawData = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(entry.data, 'utf8');

    const isEmpty = rawData.length === 0;
    const compressionMethod = isEmpty ? 0 : 8; // 0 = stored, 8 = deflated
    const compressedData = isEmpty
      ? Buffer.alloc(0)
      : zlib.deflateRawSync(rawData, { level: 6 });

    const crc = zlib.crc32(rawData);
    const { time: dosTime, date: dosDate } = toDosDateTime(entry.date);

    // ── Local File Header (30 bytes) ──────────────────────────────────────────
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // Local header signature
    localHeader.writeUInt16LE(20, 4); // Minimum version needed to extract (2.0)
    localHeader.writeUInt16LE(0x0800, 6); // General purpose flag: bit 11 = UTF-8 filename
    localHeader.writeUInt16LE(compressionMethod, 8); // Compression method
    localHeader.writeUInt16LE(dosTime, 10); // File last modification time
    localHeader.writeUInt16LE(dosDate, 12); // File last modification date
    localHeader.writeUInt32LE(crc, 14); // CRC-32
    localHeader.writeUInt32LE(compressedData.length, 18); // Compressed size
    localHeader.writeUInt32LE(rawData.length, 22); // Uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26); // File name length
    localHeader.writeUInt16LE(0, 28); // Extra field length

    const localEntry = Buffer.concat([localHeader, nameBuf, compressedData]);
    localChunks.push(localEntry);

    // ── Central Directory File Header (46 bytes) ──────────────────────────────
    const cdHeader = Buffer.alloc(46);
    cdHeader.writeUInt32LE(0x02014b50, 0); // Central directory signature
    cdHeader.writeUInt16LE(0x0314, 4); // Version made by: UNIX (0x03) + ZIP 2.0 (0x14)
    cdHeader.writeUInt16LE(20, 6); // Minimum version needed (2.0)
    cdHeader.writeUInt16LE(0x0800, 8); // General purpose flag (UTF-8)
    cdHeader.writeUInt16LE(compressionMethod, 10); // Compression method
    cdHeader.writeUInt16LE(dosTime, 12); // Last mod time
    cdHeader.writeUInt16LE(dosDate, 14); // Last mod date
    cdHeader.writeUInt32LE(crc, 16); // CRC-32
    cdHeader.writeUInt32LE(compressedData.length, 20); // Compressed size
    cdHeader.writeUInt32LE(rawData.length, 24); // Uncompressed size
    cdHeader.writeUInt16LE(nameBuf.length, 28); // File name length
    cdHeader.writeUInt16LE(0, 30); // Extra field length
    cdHeader.writeUInt16LE(0, 32); // File comment length
    cdHeader.writeUInt16LE(0, 34); // Disk number start
    cdHeader.writeUInt16LE(0, 36); // Internal file attributes
    cdHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38); // External file attributes: regular file, -rw-r--r--
    cdHeader.writeUInt32LE(offset, 42); // Relative offset of local header

    cdChunks.push(Buffer.concat([cdHeader, nameBuf]));
    offset += localEntry.length;
  }

  const cdStart = offset;
  const cdBuf = Buffer.concat(cdChunks);
  const cdSize = cdBuf.length;
  const totalEntries = localChunks.length;

  // ── End of Central Directory Record (22 bytes) ────────────────────────────
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(0, 4); // Number of this disk
  eocd.writeUInt16LE(0, 6); // Disk where central directory starts
  eocd.writeUInt16LE(totalEntries, 8); // Central directory records on this disk
  eocd.writeUInt16LE(totalEntries, 10); // Total central directory records
  eocd.writeUInt32LE(cdSize, 12); // Size of central directory
  eocd.writeUInt32LE(cdStart, 16); // Offset of start of central directory
  eocd.writeUInt16LE(0, 20); // ZIP file comment length

  return Buffer.concat([...localChunks, cdBuf, eocd]);
}
