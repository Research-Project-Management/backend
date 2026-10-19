import * as zlib from 'node:zlib';

// ============================================================================
// ZERO-DEPENDENCY PKZIP ARCHIVE PACKAGER
// ============================================================================

export function crc32(buf: Buffer): number {
  return zlib.crc32(buf) >>> 0;
}

export interface ZipEntry {
  filename: string;
  data: Buffer;
  mtime?: Date;
}

export class ZipPackager {
  private entries: ZipEntry[] = [];

  addFile(filename: string, data: Buffer, mtime = new Date()): this {
    const cleanPath = filename.replace(/\\/g, '/').replace(/^\/+/, '');
    this.entries.push({ filename: cleanPath, data, mtime });
    return this;
  }

  private assembleArchive(deflatedPayloads: Buffer[]): Buffer {
    const localHeaders: Buffer[] = [];
    const centralHeaders: Buffer[] = [];
    let offset = 0;

    for (let idx = 0; idx < this.entries.length; idx++) {
      const entry = this.entries[idx];
      const deflated = deflatedPayloads[idx];
      const filenameBuf = Buffer.from(entry.filename, 'utf8');
      const uncompressedSize = entry.data.length;
      const fileCrc = crc32(entry.data);

      let compressedData: Buffer = deflated;
      let compressionMethod = 8; // Deflate

      if (compressedData.length >= uncompressedSize) {
        compressedData = Buffer.from(entry.data);
        compressionMethod = 0; // Stored
      }
      const compressedSize = compressedData.length;

      const date = entry.mtime || new Date();
      const dosTime =
        (date.getHours() << 11) |
        (date.getMinutes() << 5) |
        Math.floor(date.getSeconds() / 2);
      const dosDate =
        ((date.getFullYear() - 1980) << 9) |
        ((date.getMonth() + 1) << 5) |
        date.getDate();

      const localHeader = Buffer.alloc(30);
      localHeader.writeUInt32LE(0x04034b50, 0);
      localHeader.writeUInt16LE(20, 4);
      localHeader.writeUInt16LE(0x0800, 6);
      localHeader.writeUInt16LE(compressionMethod, 8);
      localHeader.writeUInt16LE(dosTime, 10);
      localHeader.writeUInt16LE(dosDate, 12);
      localHeader.writeUInt32LE(fileCrc, 14);
      localHeader.writeUInt32LE(compressedSize, 18);
      localHeader.writeUInt32LE(uncompressedSize, 22);
      localHeader.writeUInt16LE(filenameBuf.length, 26);
      localHeader.writeUInt16LE(0, 28);

      localHeaders.push(localHeader, filenameBuf, compressedData);

      const centralHeader = Buffer.alloc(46);
      centralHeader.writeUInt32LE(0x02014b50, 0);
      centralHeader.writeUInt16LE(20, 4);
      centralHeader.writeUInt16LE(20, 6);
      centralHeader.writeUInt16LE(0x0800, 8);
      centralHeader.writeUInt16LE(compressionMethod, 10);
      centralHeader.writeUInt16LE(dosTime, 12);
      centralHeader.writeUInt16LE(dosDate, 14);
      centralHeader.writeUInt32LE(fileCrc, 16);
      centralHeader.writeUInt32LE(compressedSize, 20);
      centralHeader.writeUInt32LE(uncompressedSize, 24);
      centralHeader.writeUInt16LE(filenameBuf.length, 28);
      centralHeader.writeUInt16LE(0, 30);
      centralHeader.writeUInt16LE(0, 32);
      centralHeader.writeUInt16LE(0, 34);
      centralHeader.writeUInt16LE(0, 36);
      centralHeader.writeUInt32LE(0, 38);
      centralHeader.writeUInt32LE(offset, 42);

      centralHeaders.push(centralHeader, filenameBuf);
      offset += 30 + filenameBuf.length + compressedSize;
    }

    const centralDirSize = centralHeaders.reduce(
      (sum, buf) => sum + buf.length,
      0,
    );
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(this.entries.length, 8);
    eocd.writeUInt16LE(this.entries.length, 10);
    eocd.writeUInt32LE(centralDirSize, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20);

    return Buffer.concat([...localHeaders, ...centralHeaders, eocd]);
  }

  build(): Buffer {
    const deflatedPayloads = this.entries.map((entry) =>
      Buffer.from(zlib.deflateRawSync(entry.data, { level: 6 })),
    );
    return this.assembleArchive(deflatedPayloads);
  }

  async buildAsync(): Promise<Buffer> {
    const deflateRawAsync = (buf: Buffer): Promise<Buffer> =>
      new Promise((resolve, reject) => {
        zlib.deflateRaw(buf, { level: 6 }, (err, res) => {
          if (err) reject(err);
          else resolve(res);
        });
      });

    const deflatedPayloads: Buffer[] = [];
    for (const entry of this.entries) {
      deflatedPayloads.push(await deflateRawAsync(entry.data));
    }
    return this.assembleArchive(deflatedPayloads);
  }
}
