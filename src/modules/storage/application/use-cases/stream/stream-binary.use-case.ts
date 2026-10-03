import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import {
  STORAGE_DRIVER,
  STORAGE_NODE_REPOSITORY,
  STORAGE_BLOB_REPOSITORY,
} from '../../../storage.tokens';
import { IStorageDriver } from '../../../domain/ports/storage-driver.port';
import { IStorageNodeRepository } from '../../../domain/ports/storage-node.repository.port';
import { IStorageBlobRepository } from '../../../domain/ports/storage-blob.repository.port';
import { ByteRange } from '../../../domain/value-objects/byte-range.vo';
import { Readable } from 'node:stream';

export interface StreamBinaryOutput {
  stream: Readable;
  statusCode: number;
  mimeType: string;
  contentLength: number;
  contentRange?: string;
  filename: string;
  etag?: string;
}

@Injectable()
export class StreamBinaryUseCase {
  constructor(
    @Inject(STORAGE_DRIVER) private readonly driver: IStorageDriver,
    @Inject(STORAGE_NODE_REPOSITORY)
    private readonly nodeRepo: IStorageNodeRepository,
    @Inject(STORAGE_BLOB_REPOSITORY)
    private readonly blobRepo: IStorageBlobRepository,
  ) {}

  async execute(
    nodeId: string,
    rangeHeader?: string,
    ifNoneMatch?: string,
  ): Promise<StreamBinaryOutput> {
    const node = await this.nodeRepo.findById(nodeId);
    if (!node || node.isTrashed()) {
      throw new NotFoundException('File not found or has been trashed');
    }

    if (!node.blobId) {
      throw new NotFoundException(
        'Logical node has no physical binary attached',
      );
    }

    const blob = await this.blobRepo.findById(node.blobId);
    if (!blob) {
      throw new NotFoundException('Physical blob not found');
    }

    const totalSize = Number(blob.sizeBytes);
    const etag = blob.contentHash?.toHex
      ? `"${blob.contentHash.toHex()}"`
      : undefined;

    // RFC 7232 Short-Circuit: Zero driver network/disk I/O on 304 Not Modified
    if (etag && ifNoneMatch && ifNoneMatch === etag && !rangeHeader) {
      return {
        stream: null as any,
        statusCode: 304,
        mimeType: node.mimeType,
        contentLength: 0,
        filename: node.name,
        etag,
      };
    }

    const byteRange = ByteRange.parse(rangeHeader, totalSize);

    if (byteRange) {
      const { stream } = await this.driver.getStream(blob.s3Key.value(), {
        start: byteRange.start,
        end: byteRange.end,
      });

      return {
        stream,
        statusCode: 206, // 206 Partial Content
        mimeType: node.mimeType,
        contentLength: byteRange.length,
        contentRange: byteRange.getContentRangeHeader(),
        filename: node.name,
        etag,
      };
    }

    // Full file stream (200 OK)
    const { stream } = await this.driver.getStream(blob.s3Key.value());
    return {
      stream,
      statusCode: 200,
      mimeType: node.mimeType,
      contentLength: totalSize,
      filename: node.name,
      etag,
    };
  }
}
