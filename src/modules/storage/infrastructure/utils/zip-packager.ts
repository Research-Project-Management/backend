import * as zlib from 'node:zlib';

/**
 * Standard CRC-32 Table implementation for zero-dependency ZIP archive creation.
 */
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[i] = c;
}

export function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  filename: string;
  data: Buffer;
  mtime?: Date;
}

/**
 * Lightweight, standards-compliant, zero-external-dependency PKZIP Archive Packager.
 * Compresses files using standard Deflate and generates valid ZIP binaries for Fastify/Express streaming.
 */
export class ZipPackager {
  private entries: ZipEntry[] = [];

  /**
   * Adds a file entry to the ZIP archive.
   */
  addFile(filename: string, data: Buffer, mtime = new Date()): this {
    // Sanitize filename: replace backslashes with forward slashes, remove leading slashes
    const cleanPath = filename.replace(/\\/g, '/').replace(/^\/+/, '');
    this.entries.push({ filename: cleanPath, data, mtime });
    return this;
  }

  /**
   * Compiles all entries into a complete, valid PKZIP Buffer.
   */
  build(): Buffer {
    const localHeaders: Buffer[] = [];
    const centralHeaders: Buffer[] = [];
    let offset = 0;

    for (const entry of this.entries) {
      const filenameBuf = Buffer.from(entry.filename, 'utf8');
      const uncompressedSize = entry.data.length;
      const fileCrc = crc32(entry.data);

      // Compress using standard Deflate (Raw)
      const deflated = Buffer.from(
        zlib.deflateRawSync(entry.data, { level: 6 }),
      );
      let compressedData: Buffer = deflated;
      let compressionMethod = 8; // Deflate

      // If compression doesn't save space, fallback to Store (0)
      if (compressedData.length >= uncompressedSize) {
        compressedData = Buffer.from(entry.data);
        compressionMethod = 0; // Stored
      }
      const compressedSize = compressedData.length;

      // DOS Time & Date
      const date = entry.mtime || new Date();
      const dosTime =
        (date.getHours() << 11) |
        (date.getMinutes() << 5) |
        Math.floor(date.getSeconds() / 2);
      const dosDate =
        ((date.getFullYear() - 1980) << 9) |
        ((date.getMonth() + 1) << 5) |
        date.getDate();

      // ── Local File Header (30 bytes + filename + data) ───────────────
      const localHeader = Buffer.alloc(30);
      localHeader.writeUInt32LE(0x04034b50, 0); // Local header signature
      localHeader.writeUInt16LE(20, 4); // Min version (2.0)
      localHeader.writeUInt16LE(0x0800, 6); // General purpose flag: UTF-8 filename (bit 11)
      localHeader.writeUInt16LE(compressionMethod, 8); // Compression method
      localHeader.writeUInt16LE(dosTime, 10);
      localHeader.writeUInt16LE(dosDate, 12);
      localHeader.writeUInt32LE(fileCrc, 14);
      localHeader.writeUInt32LE(compressedSize, 18);
      localHeader.writeUInt32LE(uncompressedSize, 22);
      localHeader.writeUInt16LE(filenameBuf.length, 26);
      localHeader.writeUInt16LE(0, 28); // Extra field length

      localHeaders.push(localHeader, filenameBuf, compressedData);

      // ── Central Directory File Header (46 bytes + filename) ─────────
      const centralHeader = Buffer.alloc(46);
      centralHeader.writeUInt32LE(0x02014b50, 0); // Central directory signature
      centralHeader.writeUInt16LE(20, 4); // Version made by
      centralHeader.writeUInt16LE(20, 6); // Version needed to extract
      centralHeader.writeUInt16LE(0x0800, 8); // General purpose flag: UTF-8
      centralHeader.writeUInt16LE(compressionMethod, 10);
      centralHeader.writeUInt16LE(dosTime, 12);
      centralHeader.writeUInt16LE(dosDate, 14);
      centralHeader.writeUInt32LE(fileCrc, 16);
      centralHeader.writeUInt32LE(compressedSize, 20);
      centralHeader.writeUInt32LE(uncompressedSize, 24);
      centralHeader.writeUInt16LE(filenameBuf.length, 28);
      centralHeader.writeUInt16LE(0, 30); // Extra field length
      centralHeader.writeUInt16LE(0, 32); // File comment length
      centralHeader.writeUInt16LE(0, 34); // Disk number start
      centralHeader.writeUInt16LE(0, 36); // Internal file attributes
      centralHeader.writeUInt32LE(0x81a40000, 38); // External file attributes (-rw-r--r--)
      centralHeader.writeUInt32LE(offset, 42); // Relative offset of local header

      centralHeaders.push(centralHeader, filenameBuf);

      offset += localHeader.length + filenameBuf.length + compressedData.length;
    }

    const centralDirectoryOffset = offset;
    const centralDirectoryData = Buffer.concat(centralHeaders);
    const centralDirectorySize = centralDirectoryData.length;

    // ── End of Central Directory Record (22 bytes) ─────────────────────
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
    eocd.writeUInt16LE(0, 4); // Number of this disk
    eocd.writeUInt16LE(0, 6); // Disk where central directory starts
    eocd.writeUInt16LE(this.entries.length, 8); // Total records on this disk
    eocd.writeUInt16LE(this.entries.length, 10); // Total central directory records
    eocd.writeUInt32LE(centralDirectorySize, 12); // Size of central directory
    eocd.writeUInt32LE(centralDirectoryOffset, 16); // Offset of central directory
    eocd.writeUInt16LE(0, 20); // Comment length

    return Buffer.concat([...localHeaders, centralDirectoryData, eocd]);
  }
}
