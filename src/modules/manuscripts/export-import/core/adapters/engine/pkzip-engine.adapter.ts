/**
 * export-import/core/adapters/engine/pkzip-engine.adapter.ts
 * High-performance, zero-external-dependency PKZIP 2.0 compression & extraction engine
 * powered by Node.js built-in zlib. Matches Overleaf project archiving specifications.
 */

import { Injectable, Logger } from '@nestjs/common';
import * as zlib from 'node:zlib';
import { Readable } from 'node:stream';
import {
  IZipEnginePort,
  RawZipEntryInput,
} from '@/modules/manuscripts/export-import/core/ports/zip-engine.port';
import { ArchiveEntryVo } from '@/modules/manuscripts/export-import/core/domain/value-objects/archive-entry.vo';
import { InvalidZipArchiveException } from '@/modules/manuscripts/export-import/core/domain/exceptions/invalid-zip-archive.exception';
import { ArchiveSizeExceededException } from '@/modules/manuscripts/export-import/core/domain/exceptions/archive-size-exceeded.exception';
import {
  buildPkZipBuffer,
  createPkZipStream,
} from '@/modules/manuscripts/shared/zip/pkzip-builder.util';

export const MAX_UNCOMPRESSED_PROJECT_BYTES = 500 * 1024 * 1024; // 500 MB (Overleaf Zip Bomb Guard)
export const MAX_PROJECT_ENTRY_COUNT = 10000; // 10k files max

@Injectable()
export class PkzipEngineAdapter extends IZipEnginePort {
  private readonly logger = new Logger(PkzipEngineAdapter.name);

  /**
   * Encodes a list of files into a compliant PKZIP 2.0 binary buffer.
   */
  public buildZip(entries: RawZipEntryInput[]): Buffer {
    return buildPkZipBuffer(entries);
  }

  /**
   * Encodes entries into a streaming PKZIP 2.0 Readable with backpressure.
   * Lazily awaits getData() if provided, streaming payload chunk-by-chunk to reduce memory.
   */
  public createZipStream(entries: RawZipEntryInput[]): Readable {
    return createPkZipStream(entries);
  }

  /**
   * Parses and decompresses a PKZIP binary buffer, returning a sanitized list of ArchiveEntryVo.
   */
  public extractZip(zipBuffer: Buffer): ArchiveEntryVo[] {
    if (!zipBuffer || zipBuffer.length < 22) {
      throw new InvalidZipArchiveException(
        'Provided buffer is too small to be a valid ZIP archive.',
      );
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
      throw new InvalidZipArchiveException(
        'Corrupted ZIP: End of Central Directory record not found.',
      );
    }

    const totalRecords = zipBuffer.readUInt16LE(eocdOffset + 10);
    const cdSize = zipBuffer.readUInt32LE(eocdOffset + 12);
    const cdOffset = zipBuffer.readUInt32LE(eocdOffset + 16);

    if (totalRecords > MAX_PROJECT_ENTRY_COUNT) {
      throw new ArchiveSizeExceededException(
        totalRecords,
        MAX_PROJECT_ENTRY_COUNT,
      );
    }

    if (cdOffset + cdSize > zipBuffer.length) {
      throw new InvalidZipArchiveException(
        'Corrupted ZIP: Central Directory bounds exceed file size.',
      );
    }

    const entries: ArchiveEntryVo[] = [];
    let currentCdPtr = cdOffset;
    let accumulatedUncompressedBytes = 0;

    for (let r = 0; r < totalRecords; r++) {
      if (currentCdPtr + 46 > zipBuffer.length) break;

      const sig = zipBuffer.readUInt32LE(currentCdPtr);
      if (sig !== 0x02014b50) {
        throw new InvalidZipArchiveException(
          `Corrupted ZIP: Invalid central directory entry signature at ${currentCdPtr}.`,
        );
      }

      const compressionMethod = zipBuffer.readUInt16LE(currentCdPtr + 10);
      const compressedSize = zipBuffer.readUInt32LE(currentCdPtr + 20);
      const uncompressedSize = zipBuffer.readUInt32LE(currentCdPtr + 24);
      const nameLen = zipBuffer.readUInt16LE(currentCdPtr + 28);
      const extraLen = zipBuffer.readUInt16LE(currentCdPtr + 30);
      const commentLen = zipBuffer.readUInt16LE(currentCdPtr + 32);
      const localHeaderOffset = zipBuffer.readUInt32LE(currentCdPtr + 42);

      const nameStart = currentCdPtr + 46;
      const fileName = zipBuffer.toString(
        'utf8',
        nameStart,
        nameStart + nameLen,
      );

      currentCdPtr += 46 + nameLen + extraLen + commentLen;

      // Zip Bomb Guard: check uncompressed total size
      accumulatedUncompressedBytes += uncompressedSize;
      if (accumulatedUncompressedBytes > MAX_UNCOMPRESSED_PROJECT_BYTES) {
        throw new ArchiveSizeExceededException(
          accumulatedUncompressedBytes,
          MAX_UNCOMPRESSED_PROJECT_BYTES,
        );
      }

      const isDirectory = fileName.endsWith('/') || fileName.endsWith('\\');

      // Navigate to Local File Header to read payload
      if (localHeaderOffset + 30 > zipBuffer.length) {
        throw new InvalidZipArchiveException(
          `Corrupted ZIP: Local header offset out of bounds for '${fileName}'.`,
        );
      }

      const localSig = zipBuffer.readUInt32LE(localHeaderOffset);
      if (localSig !== 0x04034b50) {
        throw new InvalidZipArchiveException(
          `Corrupted ZIP: Invalid local header signature for '${fileName}'.`,
        );
      }

      const localNameLen = zipBuffer.readUInt16LE(localHeaderOffset + 26);
      const localExtraLen = zipBuffer.readUInt16LE(localHeaderOffset + 28);
      const dataOffset = localHeaderOffset + 30 + localNameLen + localExtraLen;

      let uncompressedData = Buffer.alloc(0);

      if (!isDirectory && compressedSize > 0) {
        const compressedSlice = zipBuffer.subarray(
          dataOffset,
          dataOffset + compressedSize,
        );
        if (compressionMethod === 0) {
          // Stored (no compression)
          uncompressedData = Buffer.from(compressedSlice);
        } else if (compressionMethod === 8) {
          // Deflated
          try {
            uncompressedData = zlib.inflateRawSync(compressedSlice);
          } catch (inflateErr: unknown) {
            const inflateMsg =
              inflateErr instanceof Error
                ? inflateErr.message
                : String(inflateErr);
            this.logger.warn(
              `Failed to inflate entry '${fileName}': ${inflateMsg}`,
            );
            throw new InvalidZipArchiveException(
              `Failed to decompress entry '${fileName}'.`,
            );
          }
        } else {
          this.logger.warn(
            `Unsupported ZIP compression method ${compressionMethod} for '${fileName}'. Skipping.`,
          );
          continue;
        }
      }

      // Create ArchiveEntryVo (performs automatic Zip Slip detection & path sanitization)
      const entryVo = ArchiveEntryVo.create(
        fileName,
        uncompressedData,
        isDirectory,
      );

      // Skip ignored OS artifacts (__MACOSX/, .DS_Store, Thumbs.db)
      if (!entryVo.isIgnoredSystemArtifact()) {
        entries.push(entryVo);
      }
    }

    return entries;
  }
}
