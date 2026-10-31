/**
 * modules/manuscripts/core/utils/pkzip-builder.ts
 * Canonical, zero-dependency PKZIP 2.0 binary packing and streaming utilities
 * powered by Node.js built-in zlib (Shared Kernel of Manuscripts).
 */

import * as zlib from 'zlib';
import { Readable } from 'stream';
import { promisify } from 'util';

const deflateRawAsync = promisify(zlib.deflateRaw);

/**
 * Computes the unsigned 32-bit CRC-32 checksum of a buffer or string.
 */
export function crc32(data: Buffer | string): number {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  return zlib.crc32(buf) >>> 0;
}

/**
 * Converts a JavaScript Date into MS-DOS 16-bit time and date fields for PKZIP headers.
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
 * Normalizes a relative archive path and strips path-traversal sequences.
 */
export function sanitizePkZipPath(relPath: string): string {
  return relPath
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment.length > 0 && !/^\.+$/.test(segment))
    .join('/');
}

export interface PkZipEntry {
  path: string;
  data?: Buffer | string;
  getData?: () => Promise<Buffer | string | null>;
  date?: Date;
}

/**
 * Packs a 30-byte PKZIP 2.0 Local File Header.
 */
export function packLocalFileHeader(params: {
  compressionMethod: number;
  dosTime: number;
  dosDate: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  nameLength: number;
}): Buffer {
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0); // Local header signature
  localHeader.writeUInt16LE(20, 4); // Version needed to extract (2.0)
  localHeader.writeUInt16LE(0x0800, 6); // General purpose bit flag (UTF-8)
  localHeader.writeUInt16LE(params.compressionMethod, 8);
  localHeader.writeUInt16LE(params.dosTime, 10);
  localHeader.writeUInt16LE(params.dosDate, 12);
  localHeader.writeUInt32LE(params.crc >>> 0, 14);
  localHeader.writeUInt32LE(params.compressedSize, 18);
  localHeader.writeUInt32LE(params.uncompressedSize, 22);
  localHeader.writeUInt16LE(params.nameLength, 26);
  localHeader.writeUInt16LE(0, 28); // Extra field length
  return localHeader;
}

/**
 * Packs a 46-byte PKZIP 2.0 Central Directory File Header.
 */
export function packCentralDirectoryHeader(params: {
  compressionMethod: number;
  dosTime: number;
  dosDate: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  nameLength: number;
  localHeaderOffset: number;
}): Buffer {
  const cdHeader = Buffer.alloc(46);
  cdHeader.writeUInt32LE(0x02014b50, 0); // Central directory signature
  cdHeader.writeUInt16LE(0x0314, 4); // Version made by (UNIX 2.0)
  cdHeader.writeUInt16LE(20, 6); // Version needed to extract (2.0)
  cdHeader.writeUInt16LE(0x0800, 8); // General purpose bit flag (UTF-8)
  cdHeader.writeUInt16LE(params.compressionMethod, 10);
  cdHeader.writeUInt16LE(params.dosTime, 12);
  cdHeader.writeUInt16LE(params.dosDate, 14);
  cdHeader.writeUInt32LE(params.crc >>> 0, 16);
  cdHeader.writeUInt32LE(params.compressedSize, 20);
  cdHeader.writeUInt32LE(params.uncompressedSize, 24);
  cdHeader.writeUInt16LE(params.nameLength, 28);
  cdHeader.writeUInt16LE(0, 30); // Extra field length
  cdHeader.writeUInt16LE(0, 32); // File comment length
  cdHeader.writeUInt16LE(0, 34); // Disk number start
  cdHeader.writeUInt16LE(0, 36); // Internal file attributes
  cdHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38); // External file attributes (regular file)
  cdHeader.writeUInt32LE(params.localHeaderOffset, 42); // Relative offset of local header
  return cdHeader;
}

/**
 * Packs a 22-byte PKZIP 2.0 End of Central Directory (EOCD) record.
 */
export function packEndOfCentralDirectory(params: {
  totalEntries: number;
  cdSize: number;
  cdStartOffset: number;
}): Buffer {
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // End of central directory signature
  eocd.writeUInt16LE(0, 4); // Number of this disk
  eocd.writeUInt16LE(0, 6); // Disk where central directory starts
  eocd.writeUInt16LE(params.totalEntries, 8); // Number of central directory records on this disk
  eocd.writeUInt16LE(params.totalEntries, 10); // Total number of central directory records
  eocd.writeUInt32LE(params.cdSize, 12); // Size of central directory
  eocd.writeUInt32LE(params.cdStartOffset, 16); // Offset of start of central directory
  eocd.writeUInt16LE(0, 20); // Comment length
  return eocd;
}

/**
 * Synchronously builds a compliant PKZIP 2.0 binary Buffer from in-memory entries.
 */
export function buildPkZipBuffer(entries: PkZipEntry[]): Buffer {
  const localChunks: Buffer[] = [];
  const cdChunks: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const cleanPath = sanitizePkZipPath(entry.path);
    if (!cleanPath) continue;

    const nameBuf = Buffer.from(cleanPath, 'utf8');
    const rawData = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(entry.data || '', 'utf8');

    const isEmpty = rawData.length === 0;
    const compressionMethod = isEmpty ? 0 : 8; // 0 = Store, 8 = Deflate
    const compressedData = isEmpty
      ? Buffer.alloc(0)
      : zlib.deflateRawSync(rawData, { level: 6 });

    const crc = crc32(rawData);
    const { time: dosTime, date: dosDate } = toDosDateTime(entry.date);

    const localHeader = packLocalFileHeader({
      compressionMethod,
      dosTime,
      dosDate,
      crc,
      compressedSize: compressedData.length,
      uncompressedSize: rawData.length,
      nameLength: nameBuf.length,
    });

    const localEntry = Buffer.concat([localHeader, nameBuf, compressedData]);
    localChunks.push(localEntry);

    const cdHeader = packCentralDirectoryHeader({
      compressionMethod,
      dosTime,
      dosDate,
      crc,
      compressedSize: compressedData.length,
      uncompressedSize: rawData.length,
      nameLength: nameBuf.length,
      localHeaderOffset: offset,
    });

    cdChunks.push(Buffer.concat([cdHeader, nameBuf]));
    offset += localEntry.length;
  }

  const cdStartOffset = offset;
  const cdBuf = Buffer.concat(cdChunks);
  const eocd = packEndOfCentralDirectory({
    totalEntries: localChunks.length,
    cdSize: cdBuf.length,
    cdStartOffset,
  });

  return Buffer.concat([...localChunks, cdBuf, eocd]);
}

/**
 * Creates a streaming PKZIP 2.0 Readable stream with backpressure support.
 * If an entry's `getData()` resolves to `null`, that entry is skipped gracefully.
 */
export function createPkZipStream(entries: PkZipEntry[]): Readable {
  return Readable.from(
    (async function* generatePkZipChunks() {
      const cdChunks: Buffer[] = [];
      let offset = 0;

      for (const entry of entries) {
        const cleanPath = sanitizePkZipPath(entry.path);
        if (!cleanPath) continue;

        let rawData: Buffer;
        if (entry.getData) {
          const resolved = await entry.getData();
          if (resolved === null) continue;
          rawData = Buffer.isBuffer(resolved)
            ? resolved
            : Buffer.from(resolved, 'utf8');
        } else if (entry.data !== undefined) {
          rawData = Buffer.isBuffer(entry.data)
            ? entry.data
            : Buffer.from(entry.data, 'utf8');
        } else {
          rawData = Buffer.alloc(0);
        }

        const nameBuf = Buffer.from(cleanPath, 'utf8');
        const isEmpty = rawData.length === 0;
        const compressionMethod = isEmpty ? 0 : 8; // 0 = Store, 8 = Deflate
        const compressedData: Buffer = isEmpty
          ? Buffer.alloc(0)
          : await deflateRawAsync(rawData, { level: 6 });

        const crc = crc32(rawData);
        const { time: dosTime, date: dosDate } = toDosDateTime(entry.date);

        const localHeader = packLocalFileHeader({
          compressionMethod,
          dosTime,
          dosDate,
          crc,
          compressedSize: compressedData.length,
          uncompressedSize: rawData.length,
          nameLength: nameBuf.length,
        });

        const localRecordLength =
          localHeader.length + nameBuf.length + compressedData.length;

        const cdHeader = packCentralDirectoryHeader({
          compressionMethod,
          dosTime,
          dosDate,
          crc,
          compressedSize: compressedData.length,
          uncompressedSize: rawData.length,
          nameLength: nameBuf.length,
          localHeaderOffset: offset,
        });

        cdChunks.push(Buffer.concat([cdHeader, nameBuf]));
        offset += localRecordLength;

        yield localHeader;
        yield nameBuf;
        if (compressedData.length > 0) {
          yield compressedData;
        }
      }

      const cdStartOffset = offset;
      let cdSize = 0;
      for (const cd of cdChunks) {
        cdSize += cd.length;
        yield cd;
      }

      yield packEndOfCentralDirectory({
        totalEntries: cdChunks.length,
        cdSize,
        cdStartOffset,
      });
    })(),
  );
}
