/**
 * modules/manuscripts/clsi/core/adapters/artifacts/zip.util.ts
 * Lightweight, zero-dependency PKZIP 2.0 generator utilizing Node.js built-in zlib.
 * Matches Overleaf CLSI project artifact packaging semantics.
 */

import * as zlib from 'zlib';

export interface ZipFileEntry {
  path: string;
  data: string | Buffer;
  date?: Date;
}

function toDosDateTime(d: Date = new Date()): { time: number; date: number } {
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

function sanitizeZipPath(relPath: string): string {
  return relPath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\.\.\//g, '');
}

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
    const compressionMethod = isEmpty ? 0 : 8;
    const compressedData = isEmpty
      ? Buffer.alloc(0)
      : zlib.deflateRawSync(rawData, { level: 6 });

    const crc = zlib.crc32(rawData);
    const { time: dosTime, date: dosDate } = toDosDateTime(entry.date);

    // Local Header (30 bytes)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(compressionMethod, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressedData.length, 18);
    localHeader.writeUInt32LE(rawData.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    const localEntry = Buffer.concat([localHeader, nameBuf, compressedData]);
    localChunks.push(localEntry);

    // Central Directory Header (46 bytes)
    const cdHeader = Buffer.alloc(46);
    cdHeader.writeUInt32LE(0x02014b50, 0);
    cdHeader.writeUInt16LE(0x0314, 4);
    cdHeader.writeUInt16LE(20, 6);
    cdHeader.writeUInt16LE(0x0800, 8);
    cdHeader.writeUInt16LE(compressionMethod, 10);
    cdHeader.writeUInt16LE(dosTime, 12);
    cdHeader.writeUInt16LE(dosDate, 14);
    cdHeader.writeUInt32LE(crc, 16);
    cdHeader.writeUInt32LE(compressedData.length, 20);
    cdHeader.writeUInt32LE(rawData.length, 24);
    cdHeader.writeUInt16LE(nameBuf.length, 28);
    cdHeader.writeUInt16LE(0, 30);
    cdHeader.writeUInt16LE(0, 32);
    cdHeader.writeUInt16LE(0, 34);
    cdHeader.writeUInt16LE(0, 36);
    cdHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    cdHeader.writeUInt32LE(offset, 42);

    cdChunks.push(Buffer.concat([cdHeader, nameBuf]));
    offset += localEntry.length;
  }

  const cdStart = offset;
  const cdBuf = Buffer.concat(cdChunks);
  const cdSize = cdBuf.length;
  const totalEntries = localChunks.length;

  // End of Central Directory (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(totalEntries, 8);
  eocd.writeUInt16LE(totalEntries, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, cdBuf, eocd]);
}
