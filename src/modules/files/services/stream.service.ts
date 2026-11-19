import { Injectable } from '@nestjs/common';
import { Readable } from 'node:stream';
import { StorageBlob } from '../domain/blob.domain';
import { ByteRange } from '../domain/session.domain';
import {
  FilesStreamOptions,
  FilesStreamOutput,
  StreamKeyOutput,
} from '../types/files.type';
import { BlobService } from './blob.service';

@Injectable()
export class FileStreamService {
  constructor(private readonly blobService: BlobService) {}

  async streamBlob(
    blob: Pick<StorageBlob, 's3Key' | 'sizeBytes'> & {
      contentHash?: StorageBlob['contentHash'];
    },
    options?: FilesStreamOptions,
  ): Promise<FilesStreamOutput> {
    const mimeType = options?.mimeType || 'application/octet-stream';
    const filename = options?.filename || 'download';
    const totalSize = Number(blob.sizeBytes);
    const etag = blob.contentHash?.toHex
      ? `"${blob.contentHash.toHex()}"`
      : undefined;

    if (
      etag &&
      options?.ifNoneMatch &&
      options.ifNoneMatch === etag &&
      !options.rangeHeader
    ) {
      return {
        stream: null,
        statusCode: 304,
        mimeType,
        contentLength: 0,
        filename,
        etag,
      };
    }

    const byteRange = ByteRange.parse(options?.rangeHeader, totalSize);
    if (byteRange) {
      const { stream } = await this.blobService.getStream(blob.s3Key.value(), {
        start: byteRange.start,
        end: byteRange.end,
      });

      return {
        stream: stream as Readable,
        statusCode: 206,
        mimeType,
        contentLength: byteRange.length,
        contentRange: byteRange.getContentRangeHeader(),
        filename,
        etag,
      };
    }

    const { stream } = await this.blobService.getStream(blob.s3Key.value());
    return {
      stream: stream as Readable,
      statusCode: 200,
      mimeType,
      contentLength: totalSize,
      filename,
      etag,
    };
  }

  async streamByKey(
    key: string,
    rangeHeader?: string,
  ): Promise<StreamKeyOutput> {
    let range: { start: number; end: number } | undefined;
    if (rangeHeader) {
      const stat = await this.blobService.stat(key);
      const parsed = ByteRange.parse(rangeHeader, stat.size);
      if (parsed) {
        range = { start: parsed.start, end: parsed.end };
      }
    }
    const res = await this.blobService.getStream(key, range);
    return {
      stream: res.stream,
      contentType: 'application/octet-stream',
      contentLength: res.contentLength,
      contentRange: res.contentRange,
    };
  }

  async getPresignedDownloadUrl(
    key: string,
    options: { expiresInSeconds?: number; filename?: string },
  ): Promise<string> {
    return this.blobService.getPresignedDownloadUrl(key, options);
  }
}
