/**
 * export-import/core/adapters/engine/pkzip-engine.adapter.ts
 * High-performance, zero-external-dependency PKZIP 2.0 compression & extraction engine
 * powered by Node.js built-in zlib. Matches Overleaf project archiving specifications.
 */

import { Injectable, Logger } from '@nestjs/common';
import * as zlib from 'node:zlib';
import { IZipEnginePort, RawZipEntryInput } from '../../ports/zip-engine.port';
import { ArchiveEntryVo } from '../../domain/value-objects/archive-entry.vo';
import { InvalidZipArchiveException } from '../../domain/exceptions/invalid-zip-archive.exception';
import { ArchiveSizeExceededException } from '../../domain/exceptions/archive-size-exceeded.exception';

export const MAX_UNCOMPRESSED_PROJECT_BYTES = 500 * 1024 * 1024; // 500 MB (Overleaf Zip Bomb Guard)
export const MAX_PROJECT_ENTRY_COUNT = 10000; // 10k files max

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

@Injectable()
export class PkzipEngineAdapter extends IZipEnginePort {
  private readonly logger = new Logger(PkzipEngineAdapter.name);

  /**
   * Encodes a list of files into a compliant PKZIP 2.0 binary buffer.
   */
  public buildZip(entries: RawZipEntryInput[]): Buffer {
    const localChunks: Buffer[] = [];
    const cdChunks: Buffer[] = [];
    let offset = 0;

    for (const entry of entries) {
      const cleanPath = entry.path.replace(/\\/g, '/').replace(/^\/+/, '');
      if (!cleanPath) continue;

      const nameBuf = Buffer.from(cleanPath, 'utf8');
      const rawData = Buffer.isBuffer(entry.data)
        ? entry.data
        : Buffer.from(entry.data, 'utf8');

      const isEmpty = rawData.length === 0;
      const compressionMethod = isEmpty ? 0 : 8; // 0 = Store, 8 = Deflate
      const compressedData = isEmpty
        ? Buffer.alloc(0)
        : zlib.deflateRawSync(rawData, { level: 6 });

      const crc = zlib.crc32(rawData);
      const { time: dosTime, date: dosDate } = toDosDateTime(entry.date);

      // Local File Header (30 bytes)
      const localHeader = Buffer.alloc(30);
      localHeader.writeUInt32LE(0x04034b50, 0); // Local header signature
      localHeader.writeUInt16LE(20, 4);         // Version needed to extract (2.0)
      localHeader.writeUInt16LE(0x0800, 6);     // General purpose bit flag (UTF-8)
      localHeader.writeUInt16LE(compressionMethod, 8);
      localHeader.writeUInt16LE(dosTime, 10);
      localHeader.writeUInt16LE(dosDate, 12);
      localHeader.writeUInt32LE(crc, 14);
      localHeader.writeUInt32LE(compressedData.length, 18);
      localHeader.writeUInt32LE(rawData.length, 22);
      localHeader.writeUInt16LE(nameBuf.length, 26);
      localHeader.writeUInt16LE(0, 28);         // Extra field length

      const localEntry = Buffer.concat([localHeader, nameBuf, compressedData]);
      localChunks.push(localEntry);

      // Central Directory Header (46 bytes)
      const cdHeader = Buffer.alloc(46);
      cdHeader.writeUInt32LE(0x02014b50, 0);     // Central directory file header signature
      cdHeader.writeUInt16LE(0x0314, 4);         // Version made by (UNIX 2.0)
      cdHeader.writeUInt16LE(20, 6);             // Version needed to extract (2.0)
      cdHeader.writeUInt16LE(0x0800, 8);         // General purpose bit flag (UTF-8)
      cdHeader.writeUInt16LE(compressionMethod, 10);
      cdHeader.writeUInt16LE(dosTime, 12);
      cdHeader.writeUInt16LE(dosDate, 14);
      cdHeader.writeUInt32LE(crc, 16);
      cdHeader.writeUInt32LE(compressedData.length, 20);
      cdHeader.writeUInt32LE(rawData.length, 24);
      cdHeader.writeUInt16LE(nameBuf.length, 28);
      cdHeader.writeUInt16LE(0, 30);             // Extra field length
      cdHeader.writeUInt16LE(0, 32);             // File comment length
      cdHeader.writeUInt16LE(0, 34);             // Disk number start
      cdHeader.writeUInt16LE(0, 36);             // Internal file attributes
      cdHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38); // External file attributes (regular file)
      cdHeader.writeUInt32LE(offset, 42);        // Relative offset of local header

      cdChunks.push(Buffer.concat([cdHeader, nameBuf]));
      offset += localEntry.length;
    }

    const cdStart = offset;
    const cdBuf = Buffer.concat(cdChunks);
    const cdSize = cdBuf.length;
    const totalEntries = localChunks.length;

    // End of Central Directory (22 bytes)
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);           // End of central directory signature
    eocd.writeUInt16LE(0, 4);                   // Number of this disk
    eocd.writeUInt16LE(0, 6);                   // Disk where central directory starts
    eocd.writeUInt16LE(totalEntries, 8);        // Number of central directory records on this disk
    eocd.writeUInt16LE(totalEntries, 10);       // Total number of central directory records
    eocd.writeUInt32LE(cdSize, 12);             // Size of central directory
    eocd.writeUInt32LE(cdStart, 16);            // Offset of start of central directory
    eocd.writeUInt16LE(0, 20);                  // Comment length

    return Buffer.concat([...localChunks, cdBuf, eocd]);
  }

  /**
   * Parses and decompresses a PKZIP binary buffer, returning a sanitized list of ArchiveEntryVo.
   */
  public extractZip(zipBuffer: Buffer): ArchiveEntryVo[] {
    if (!zipBuffer || zipBuffer.length < 22) {
      throw new InvalidZipArchiveException('Provided buffer is too small to be a valid ZIP archive.');
    }

    // 1. Locate End of Central Directory record (0x06054b50) scanning backwards
    let eocdOffset = -1;
    const maxScan = Math.min(zipBuffer.length, 65557); // 22 bytes min + 65535 max comment
    const scanStart = zipBuffer.length - 22;
    const scanEnd = Math.max(0, zipBuffer.length - maxScan);

    for (let i = scanStart; i >= scanEnd; i--) {
      if (zipBuffer.readUInt32LE(i) === 0x06054b50) {
        eocdOffset = i;
        break;
      }
    }

    if (eocdOffset === -1) {
      throw new InvalidZipArchiveException('Corrupted ZIP: End of Central Directory record not found.');
    }

    const totalRecords = zipBuffer.readUInt16LE(eocdOffset + 10);
    const cdSize = zipBuffer.readUInt32LE(eocdOffset + 12);
    const cdOffset = zipBuffer.readUInt32LE(eocdOffset + 16);

    if (totalRecords > MAX_PROJECT_ENTRY_COUNT) {
      throw new ArchiveSizeExceededException(totalRecords, MAX_PROJECT_ENTRY_COUNT);
    }

    if (cdOffset + cdSize > zipBuffer.length) {
      throw new InvalidZipArchiveException('Corrupted ZIP: Central Directory bounds exceed file size.');
    }

    const entries: ArchiveEntryVo[] = [];
    let currentCdPtr = cdOffset;
    let accumulatedUncompressedBytes = 0;

    for (let r = 0; r < totalRecords; r++) {
      if (currentCdPtr + 46 > zipBuffer.length) break;

      const sig = zipBuffer.readUInt32LE(currentCdPtr);
      if (sig !== 0x02014b50) {
        throw new InvalidZipArchiveException(`Corrupted ZIP: Invalid central directory entry signature at ${currentCdPtr}.`);
      }

      const compressionMethod = zipBuffer.readUInt16LE(currentCdPtr + 10);
      const compressedSize = zipBuffer.readUInt32LE(currentCdPtr + 20);
      const uncompressedSize = zipBuffer.readUInt32LE(currentCdPtr + 24);
      const nameLen = zipBuffer.readUInt16LE(currentCdPtr + 28);
      const extraLen = zipBuffer.readUInt16LE(currentCdPtr + 30);
      const commentLen = zipBuffer.readUInt16LE(currentCdPtr + 32);
      const localHeaderOffset = zipBuffer.readUInt32LE(currentCdPtr + 42);

      const nameStart = currentCdPtr + 46;
      const fileName = zipBuffer.toString('utf8', nameStart, nameStart + nameLen);

      currentCdPtr += 46 + nameLen + extraLen + commentLen;

      // Zip Bomb Guard: check uncompressed total size
      accumulatedUncompressedBytes += uncompressedSize;
      if (accumulatedUncompressedBytes > MAX_UNCOMPRESSED_PROJECT_BYTES) {
        throw new ArchiveSizeExceededException(accumulatedUncompressedBytes, MAX_UNCOMPRESSED_PROJECT_BYTES);
      }

      const isDirectory = fileName.endsWith('/') || fileName.endsWith('\\');

      // Navigate to Local File Header to read payload
      if (localHeaderOffset + 30 > zipBuffer.length) {
        throw new InvalidZipArchiveException(`Corrupted ZIP: Local header offset out of bounds for '${fileName}'.`);
      }

      const localSig = zipBuffer.readUInt32LE(localHeaderOffset);
      if (localSig !== 0x04034b50) {
        throw new InvalidZipArchiveException(`Corrupted ZIP: Invalid local header signature for '${fileName}'.`);
      }

      const localNameLen = zipBuffer.readUInt16LE(localHeaderOffset + 26);
      const localExtraLen = zipBuffer.readUInt16LE(localHeaderOffset + 28);
      const dataOffset = localHeaderOffset + 30 + localNameLen + localExtraLen;

      let uncompressedData = Buffer.alloc(0);

      if (!isDirectory && compressedSize > 0) {
        const compressedSlice = zipBuffer.subarray(dataOffset, dataOffset + compressedSize);
        if (compressionMethod === 0) {
          // Stored (no compression)
          uncompressedData = Buffer.from(compressedSlice);
        } else if (compressionMethod === 8) {
          // Deflated
          try {
            uncompressedData = zlib.inflateRawSync(compressedSlice);
          } catch (inflateErr: any) {
            this.logger.warn(`Failed to inflate entry '${fileName}': ${inflateErr.message}`);
            throw new InvalidZipArchiveException(`Failed to decompress entry '${fileName}'.`);
          }
        } else {
          this.logger.warn(`Unsupported ZIP compression method ${compressionMethod} for '${fileName}'. Skipping.`);
          continue;
        }
      }

      // Create ArchiveEntryVo (performs automatic Zip Slip detection & path sanitization)
      const entryVo = ArchiveEntryVo.create(fileName, uncompressedData, isDirectory);

      // Skip ignored OS artifacts (__MACOSX/, .DS_Store, Thumbs.db)
      if (!entryVo.isIgnoredSystemArtifact()) {
        entries.push(entryVo);
      }
    }

    return entries;
  }
}
