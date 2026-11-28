import * as zlib from 'node:zlib';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { Injectable, Logger } from '@nestjs/common';
import { buildZipBuffer, createZipStream } from '@/modules/pages/core';
import { ArchiveEntryVo } from '../domain/archive.domain';
import {
  ArchiveFileLimitExceededException,
  ArchiveSizeExceededException,
  InvalidZipArchiveException,
} from '../domain/archive.errors';
import {
  MAX_PROJECT_ENTRY_COUNT,
  MAX_SINGLE_FILE_BYTES,
  MAX_UNCOMPRESSED_PROJECT_BYTES,
} from '../domain/archive.policy';
import type { RawZipEntryInput } from '../types/archive.types';

const inflateRawAsync = promisify(zlib.inflateRaw);
const ZIP_BOMB_RATIO_THRESHOLD_BYTES = 1 * 1024 * 1024;
const ZIP_BOMB_MAX_RATIO = 100;

@Injectable()
export class ZipAdapter {
  private readonly logger = new Logger(ZipAdapter.name);

  public buildZip(entries: RawZipEntryInput[]): Buffer {
    return buildZipBuffer(entries);
  }

  public createZipStream(entries: RawZipEntryInput[]): Readable {
    return createZipStream(entries);
  }

  public async extractZip(zipBuffer: Buffer): Promise<ArchiveEntryVo[]> {
    const { entries } = await this.extractZipWithSkipped(zipBuffer);
    return entries;
  }

  public async extractZipWithSkipped(
    zipBuffer: Buffer,
  ): Promise<{ entries: ArchiveEntryVo[]; skippedFiles: string[] }> {
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
      throw new ArchiveFileLimitExceededException(MAX_PROJECT_ENTRY_COUNT);
    }

    let offset = cdOffset;
    let totalUncompressedBytes = 0;
    const entries: ArchiveEntryVo[] = [];
    const skippedFiles: string[] = [];

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
        skippedFiles.push(fileName);
        continue;
      }

      const localFileNameLength = zipBuffer.readUInt16LE(
        localHeaderOffset + 26,
      );
      const localExtraFieldLength = zipBuffer.readUInt16LE(
        localHeaderOffset + 28,
      );
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

        const remainingBudget =
          MAX_UNCOMPRESSED_PROJECT_BYTES - totalUncompressedBytes;
        const maxEntryOutput = Math.min(MAX_SINGLE_FILE_BYTES, remainingBudget);
        const slice = zipBuffer.subarray(
          dataOffset,
          dataOffset + compressedSize,
        );
        const inflated = await this.decompressSlice(
          compressionMethod,
          slice,
          declaredUncompressedSize,
          maxEntryOutput,
          fileName,
        );
        if (inflated === null) {
          skippedFiles.push(fileName);
          continue;
        }
        uncompressedData = inflated;
      }

      totalUncompressedBytes += uncompressedData.length;
      if (totalUncompressedBytes > MAX_UNCOMPRESSED_PROJECT_BYTES) {
        throw new ArchiveSizeExceededException(
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
      } else if (!isDirectory) {
        skippedFiles.push(entryVo.path);
      }
    }

    return { entries, skippedFiles };
  }

  private async decompressSlice(
    method: number,
    slice: Buffer,
    declaredUncompressedSize: number,
    maxOutputBytes: number,
    fileName: string,
  ): Promise<Buffer | null> {
    if (method === 0) {
      if (slice.length > maxOutputBytes) {
        throw new ArchiveSizeExceededException(slice.length, maxOutputBytes);
      }
      return Buffer.from(slice);
    }

    if (method === 8) {
      if (
        slice.length > 0 &&
        declaredUncompressedSize > ZIP_BOMB_RATIO_THRESHOLD_BYTES &&
        declaredUncompressedSize / slice.length > ZIP_BOMB_MAX_RATIO
      ) {
        throw new InvalidZipArchiveException(
          `Suspicious compression ratio detected in entry '${fileName}' (zip bomb protection).`,
        );
      }

      try {
        const inflated = await inflateRawAsync(slice, {
          maxOutputLength: Math.max(1, maxOutputBytes),
        });
        if (
          slice.length > 0 &&
          inflated.length > ZIP_BOMB_RATIO_THRESHOLD_BYTES &&
          inflated.length / slice.length > ZIP_BOMB_MAX_RATIO
        ) {
          throw new InvalidZipArchiveException(
            `Suspicious compression ratio detected in entry '${fileName}' (zip bomb protection).`,
          );
        }
        return inflated;
      } catch (err: unknown) {
        if (err instanceof InvalidZipArchiveException) throw err;
        if ((err as { code?: string })?.code === 'ERR_BUFFER_TOO_LARGE') {
          throw new ArchiveSizeExceededException(
            maxOutputBytes + 1,
            maxOutputBytes,
          );
        }
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Failed to inflate entry '${fileName}': ${msg}`);
        throw new InvalidZipArchiveException(
          `Failed to decompress entry '${fileName}'.`,
        );
      }
    }

    this.logger.warn(
      `Unsupported ZIP compression method ${method} for '${fileName}'. Skipping.`,
    );
    return null;
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
