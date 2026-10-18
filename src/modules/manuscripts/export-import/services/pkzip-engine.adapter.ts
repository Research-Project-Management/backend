/**
 * modules/manuscripts/export-import/services/pkzip-engine.adapter.ts
 * Infrastructure / Adapter: PKZIP streaming & buffer engine implementing IZipEnginePort.
 */

import * as zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { Injectable, Logger } from '@nestjs/common';
import {
  buildPkZipBuffer,
  createPkZipStream,
} from '@/modules/manuscripts/core';
import {
  IZipEnginePort,
  RawZipEntryInput,
  ArchiveEntryVo,
  InvalidZipArchiveException,
} from '../domain/archive-validator';

@Injectable()
export class PkzipEngineAdapter extends IZipEnginePort {
  private readonly logger = new Logger(PkzipEngineAdapter.name);

  public buildZip(entries: RawZipEntryInput[]): Buffer {
    return buildPkZipBuffer(entries);
  }

  public createZipStream(entries: RawZipEntryInput[]): Readable {
    return createPkZipStream(entries);
  }

  public extractZip(zipBuffer: Buffer): ArchiveEntryVo[] {
    if (!zipBuffer || zipBuffer.length < 22) {
      throw new InvalidZipArchiveException(
        'Provided buffer is too small to be a valid ZIP archive.',
      );
    }

    let eocdOffset = -1;
    const maxScan = Math.min(zipBuffer.length, 65557);
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
        'End of Central Directory (EOCD) signature not found in archive.',
      );
    }

    const cdTotalEntries = zipBuffer.readUInt16LE(eocdOffset + 10);
    const cdOffset = zipBuffer.readUInt32LE(eocdOffset + 16);

    let offset = cdOffset;
    const entries: ArchiveEntryVo[] = [];

    for (let i = 0; i < cdTotalEntries; i++) {
      if (
        offset + 46 > zipBuffer.length ||
        zipBuffer.readUInt32LE(offset) !== 0x02014b50
      ) {
        break;
      }

      const compressionMethod = zipBuffer.readUInt16LE(offset + 10);
      const compressedSize = zipBuffer.readUInt32LE(offset + 20);
      const uncompressedSize = zipBuffer.readUInt32LE(offset + 24);
      const fileNameLength = zipBuffer.readUInt16LE(offset + 28);
      const extraFieldLength = zipBuffer.readUInt16LE(offset + 30);
      const commentLength = zipBuffer.readUInt16LE(offset + 32);
      const localHeaderOffset = zipBuffer.readUInt32LE(offset + 42);

      const fileName = zipBuffer.toString(
        'utf8',
        offset + 46,
        offset + 46 + fileNameLength,
      );

      offset += 46 + fileNameLength + extraFieldLength + commentLength;

      if (localHeaderOffset + 30 > zipBuffer.length) {
        continue;
      }
      if (zipBuffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
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
        fileName.endsWith('/') ||
        fileName.endsWith('\\') ||
        (compressedSize === 0 &&
          uncompressedSize === 0 &&
          fileName.includes('/'));

      let uncompressedData: Buffer = Buffer.alloc(0);

      if (!isDirectory && compressedSize > 0) {
        const compressedSlice = zipBuffer.subarray(
          dataOffset,
          dataOffset + compressedSize,
        );

        if (compressionMethod === 0) {
          uncompressedData = Buffer.from(compressedSlice);
        } else if (compressionMethod === 8) {
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
}
