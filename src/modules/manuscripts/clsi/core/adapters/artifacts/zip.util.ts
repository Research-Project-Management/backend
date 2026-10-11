/**
 * modules/manuscripts/clsi/core/adapters/artifacts/zip.util.ts
 * Lightweight, zero-dependency PKZIP 2.0 streaming generator utilizing Node.js built-in zlib.
 * Matches Overleaf CLSI project artifact packaging semantics with streaming backpressure.
 */

import * as zlib from 'zlib';
import * as fsp from 'fs/promises';
import { Readable } from 'stream';
import { promisify } from 'util';

const deflateRawAsync = promisify(zlib.deflateRaw);

export interface ZipFileEntry {
  path: string;
  data: string | Buffer;
  date?: Date;
}

export interface ZipDiskEntry {
  fullPath: string;
  relPath: string;
  date?: Date;
}

export type ZipEntry = ZipFileEntry | ZipDiskEntry;

function isDiskEntry(entry: ZipEntry): entry is ZipDiskEntry {
  return 'fullPath' in entry && 'relPath' in entry;
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

export function sanitizeZipPath(relPath: string): string {
  return relPath
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\.\.\//g, '');
}

/**
 * Creates a streamable PKZIP 2.0 Readable stream from disk files.
 * Streams files one-by-one with backpressure, avoiding massive memory spikes
 * for large PDFs and graphic assets.
 */
export function createZipStreamFromDisk(files: ZipDiskEntry[]): Readable {
  return createZipStream(files);
}

/**
 * Universal PKZIP 2.0 stream generator supporting both in-memory entries and disk files.
 * Emits chunks asynchronously respecting Node.js stream backpressure.
 */
export function createZipStream(entries: ZipEntry[]): Readable {
  return Readable.from(
    (async function* generateZipChunks() {
      const cdChunks: Buffer[] = [];
      let offset = 0;

      for (const entry of entries) {
        const rawPath = isDiskEntry(entry) ? entry.relPath : entry.path;
        const cleanPath = sanitizeZipPath(rawPath);
        if (!cleanPath) continue;

        const nameBuf = Buffer.from(cleanPath, 'utf8');

        let rawData: Buffer;
        if (isDiskEntry(entry)) {
          try {
            rawData = await fsp.readFile(entry.fullPath);
          } catch {
            // Skip unreadable or concurrently deleted files
            continue;
          }
        } else {
          rawData = Buffer.isBuffer(entry.data)
            ? entry.data
            : Buffer.from(entry.data, 'utf8');
        }

        const isEmpty = rawData.length === 0;
        const compressionMethod = isEmpty ? 0 : 8;
        const compressedData: Buffer = isEmpty
          ? Buffer.alloc(0)
          : ((await deflateRawAsync(rawData, { level: 6 })) as Buffer);

        const crc = zlib.crc32(rawData);
        const { time: dosTime, date: dosDate } = toDosDateTime(entry.date);

        // Local Header (30 bytes)
        const localHeader = Buffer.alloc(30);
        localHeader.writeUInt32LE(0x04034b50, 0); // Local header signature
        localHeader.writeUInt16LE(20, 4); // Version needed to extract (2.0)
        localHeader.writeUInt16LE(0x0800, 6); // General purpose bit flag (UTF-8)
        localHeader.writeUInt16LE(compressionMethod, 8);
        localHeader.writeUInt16LE(dosTime, 10);
        localHeader.writeUInt16LE(dosDate, 12);
        localHeader.writeUInt32LE(crc, 14);
        localHeader.writeUInt32LE(compressedData.length, 18);
        localHeader.writeUInt32LE(rawData.length, 22);
        localHeader.writeUInt16LE(nameBuf.length, 26);
        localHeader.writeUInt16LE(0, 28); // Extra field length

        const localRecordLength =
          localHeader.length + nameBuf.length + compressedData.length;

        // Central Directory Header (46 bytes)
        const cdHeader = Buffer.alloc(46);
        cdHeader.writeUInt32LE(0x02014b50, 0); // Central directory signature
        cdHeader.writeUInt16LE(0x0314, 4); // UNIX 2.0
        cdHeader.writeUInt16LE(20, 6); // Version needed (2.0)
        cdHeader.writeUInt16LE(0x0800, 8); // UTF-8
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
        offset += localRecordLength;

        // Yield local header, then filename, then compressed bytes
        yield localHeader;
        yield nameBuf;
        if (compressedData.length > 0) {
          yield compressedData;
        }
      }

      const cdStart = offset;
      let cdSize = 0;
      for (const cd of cdChunks) {
        cdSize += cd.length;
        yield cd;
      }

      // End of Central Directory (22 bytes)
      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(0x06054b50, 0);
      eocd.writeUInt16LE(0, 4);
      eocd.writeUInt16LE(0, 6);
      eocd.writeUInt16LE(cdChunks.length, 8);
      eocd.writeUInt16LE(cdChunks.length, 10);
      eocd.writeUInt32LE(cdSize, 12);
      eocd.writeUInt32LE(cdStart, 16);
      eocd.writeUInt16LE(0, 20);

      yield eocd;
    })(),
  );
}

/**
 * Synchronously build a full ZIP Buffer in memory.
 * Preserved for backward compatibility and fast small tests.
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
