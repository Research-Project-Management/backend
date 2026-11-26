/**
 * modules/pages/export-import/adapters/zip.adapter.ts
 *
 * GoF Adapter + Strategy Pattern (Decompression Method Strategies):
 * PKZIP streaming & buffer engine implementing `IZipEnginePort` with Zip-Slip & Zip-Bomb guards.
 */

import * as zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { Injectable, Logger } from '@nestjs/common';
import { buildZipBuffer, createZipStream } from '@/modules/pages/core';
import { ArchiveEntryVo } from '../domain/archive.domain';
import { IZipEnginePort } from '../domain/archive.ports';
import {
  ArchiveQuotaExceededException,
  InvalidZipArchiveException,
} from '../domain/archive.errors';
import {
  MAX_PROJECT_ENTRY_COUNT,
  MAX_SINGLE_FILE_BYTES,
  MAX_UNCOMPRESSED_PROJECT_BYTES,
} from '../domain/archive.policy';
import type { RawZipEntryInput } from '../types/archive.types';

interface DecompressionContext {
  fileName: string;
  compressedSlice: Buffer;
  compressedSize: number;
  declaredUncompressedSize: number;
  logger: Logger;
}

/**
 * GoF Strategy Pattern: Encapsulates PKZIP entry decompression algorithms (STORE=0, DEFLATE=8).
 */
interface IZipDecompressionStrategy {
  readonly methodCode: number;
  decompress(ctx: DecompressionContext): Buffer;
}

class StoredZipDecompressionStrategy implements IZipDecompressionStrategy {
  public readonly methodCode = 0;

  public decompress(ctx: DecompressionContext): Buffer {
    if (ctx.compressedSlice.length > MAX_SINGLE_FILE_BYTES) {
      throw new ArchiveQuotaExceededException(
        ctx.compressedSlice.length,
        MAX_SINGLE_FILE_BYTES,
      );
    }
    return Buffer.from(ctx.compressedSlice);
  }
}

class DeflateZipDecompressionStrategy implements IZipDecompressionStrategy {
  public readonly methodCode = 8;

  public decompress(ctx: DecompressionContext): Buffer {
    const {
      fileName,
      compressedSlice,
      compressedSize,
      declaredUncompressedSize,
      logger,
    } = ctx;

    if (
      compressedSize > 0 &&
      declaredUncompressedSize > 10 * 1024 * 1024 &&
      declaredUncompressedSize / compressedSize > 100
    ) {
      throw new InvalidZipArchiveException(
        `Suspicious compression ratio detected in entry '${fileName}' (zip bomb protection).`,
      );
    }

    try {
      const inflated = zlib.inflateRawSync(compressedSlice, {
        maxOutputLength: MAX_SINGLE_FILE_BYTES,
      });
      if (
        compressedSize > 0 &&
        inflated.length > 10 * 1024 * 1024 &&
        inflated.length / compressedSize > 100
      ) {
        throw new InvalidZipArchiveException(
          `Suspicious compression ratio detected in entry '${fileName}' (zip bomb protection).`,
        );
      }
      return inflated;
    } catch (inflateErr: unknown) {
      if (inflateErr instanceof InvalidZipArchiveException) {
        throw inflateErr;
      }
      const errCode = (inflateErr as { code?: string })?.code;
      if (errCode === 'ERR_BUFFER_TOO_LARGE') {
        throw new ArchiveQuotaExceededException(
          MAX_SINGLE_FILE_BYTES + 1,
          MAX_SINGLE_FILE_BYTES,
        );
      }
      const inflateMsg =
        inflateErr instanceof Error ? inflateErr.message : String(inflateErr);
      logger.warn(`Failed to inflate entry '${fileName}': ${inflateMsg}`);
      throw new InvalidZipArchiveException(
        `Failed to decompress entry '${fileName}'.`,
      );
    }
  }
}

const DECOMPRESSION_STRATEGIES = new Map<number, IZipDecompressionStrategy>([
  [0, new StoredZipDecompressionStrategy()],
  [8, new DeflateZipDecompressionStrategy()],
]);

@Injectable()
export class ZipAdapter extends IZipEnginePort {
  private readonly logger = new Logger(ZipAdapter.name);

  public buildZip(entries: RawZipEntryInput[]): Buffer {
    return buildZipBuffer(entries);
  }

  public createZipStream(entries: RawZipEntryInput[]): Readable {
    return createZipStream(entries);
  }

  public extractZip(zipBuffer: Buffer): ArchiveEntryVo[] {
    if (!zipBuffer || zipBuffer.length < 22) {
      throw new InvalidZipArchiveException(
        'Provided buffer is too small to be a valid ZIP archive.',
      );
    }

    const eocdOffset = this.locateEocdOffset(zipBuffer);
    if (eocdOffset === -1) {
      throw new InvalidZipArchiveException(
        'End of Central Directory (EOCD) signature not found in archive.',
      );
    }

    const cdTotalEntries = zipBuffer.readUInt16LE(eocdOffset + 10);
    const cdOffset = zipBuffer.readUInt32LE(eocdOffset + 16);

    if (cdTotalEntries === 0xffff || cdOffset === 0xffffffff) {
      throw new InvalidZipArchiveException('ZIP64 archives are not supported.');
    }

    if (cdTotalEntries > MAX_PROJECT_ENTRY_COUNT) {
      throw new ArchiveQuotaExceededException(
        cdTotalEntries,
        MAX_PROJECT_ENTRY_COUNT,
      );
    }

    let offset = cdOffset;
    let totalUncompressedBytes = 0;
    const entries: ArchiveEntryVo[] = [];

    for (let i = 0; i < cdTotalEntries; i++) {
      if (
        offset + 46 > zipBuffer.length ||
        zipBuffer.readUInt32LE(offset) !== 0x02014b50
      ) {
        throw new InvalidZipArchiveException(
          `Corrupted or truncated ZIP central directory at entry ${i} of ${cdTotalEntries}.`,
        );
      }

      const compressionMethod = zipBuffer.readUInt16LE(offset + 10);
      const compressedSize = zipBuffer.readUInt32LE(offset + 20);
      const declaredUncompressedSize = zipBuffer.readUInt32LE(offset + 24);
      const fileNameLength = zipBuffer.readUInt16LE(offset + 28);
      const extraFieldLength = zipBuffer.readUInt16LE(offset + 30);
      const commentLength = zipBuffer.readUInt16LE(offset + 32);
      const externalAttr = zipBuffer.readUInt32LE(offset + 38);
      const isDosDir = (externalAttr & 0x10) !== 0;
      const localHeaderOffset = zipBuffer.readUInt32LE(offset + 42);

      const fileName = zipBuffer.toString(
        'utf8',
        offset + 46,
        offset + 46 + fileNameLength,
      );

      offset += 46 + fileNameLength + extraFieldLength + commentLength;

      if (
        localHeaderOffset + 30 > zipBuffer.length ||
        zipBuffer.readUInt32LE(localHeaderOffset) !== 0x04034b50
      ) {
        continue;
      }

      const localFileNameLength = zipBuffer.readUInt16LE(localHeaderOffset + 26);
      const localExtraFieldLength = zipBuffer.readUInt16LE(localHeaderOffset + 28);
      const dataOffset =
        localHeaderOffset + 30 + localFileNameLength + localExtraFieldLength;
      const isDirectory =
        fileName.endsWith('/') || fileName.endsWith('\\') || isDosDir;

      let uncompressedData: Buffer = Buffer.alloc(0);

      if (!isDirectory && compressedSize > 0) {
        if (dataOffset + compressedSize > zipBuffer.length) {
          throw new InvalidZipArchiveException(
            `Truncated ZIP entry data for '${fileName}'.`,
          );
        }

        const strategy = DECOMPRESSION_STRATEGIES.get(compressionMethod);
        if (!strategy) {
          this.logger.warn(
            `Unsupported ZIP compression method ${compressionMethod} for '${fileName}'. Skipping.`,
          );
          continue;
        }

        uncompressedData = strategy.decompress({
          fileName,
          compressedSlice: zipBuffer.subarray(
            dataOffset,
            dataOffset + compressedSize,
          ),
          compressedSize,
          declaredUncompressedSize,
          logger: this.logger,
        });
      }

      totalUncompressedBytes += uncompressedData.length;
      if (totalUncompressedBytes > MAX_UNCOMPRESSED_PROJECT_BYTES) {
        throw new ArchiveQuotaExceededException(
          totalUncompressedBytes,
          MAX_UNCOMPRESSED_PROJECT_BYTES,
        );
      }

      const entryVo = ArchiveEntryVo.create(
        fileName,
        uncompressedData,
        isDirectory,
      );

      if (!entryVo.isIgnoredSystemArtifact()) {
        entries.push(entryVo);
      }
    }

    return entries;
  }

  private locateEocdOffset(zipBuffer: Buffer): number {
    const maxScan = Math.min(zipBuffer.length, 65557);
    const scanStart = zipBuffer.length - 22;
    const scanEnd = Math.max(0, zipBuffer.length - maxScan);

    for (let i = scanStart; i >= scanEnd; i--) {
      if (zipBuffer.readUInt32LE(i) === 0x06054b50) {
        return i;
      }
    }
    return -1;
  }
}
