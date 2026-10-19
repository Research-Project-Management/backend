import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { STORAGE_NODE_REPOSITORY } from '@/modules/storage/storage.tokens';
import {
  BlobService,
  StorageRedisCacheService,
  ZipPackager,
  sanitizeFilename,
} from '@/modules/storage/core';
import {
  IStorageNodeRepository,
  StorageNode,
  StorageAccessPolicy,
} from '@/modules/storage/drive';
import { ByteRange, StreamBinaryOutput } from '../types';

export type { StreamBinaryOutput };

@Injectable()
export class StreamService {
  private readonly logger = new Logger(StreamService.name);

  constructor(
    private readonly blobService: BlobService,
    @Inject(STORAGE_NODE_REPOSITORY)
    private readonly nodeRepo: IStorageNodeRepository,
    private readonly cache: StorageRedisCacheService,
    private readonly accessPolicy: StorageAccessPolicy,
  ) {}

  async verifyReadAccess(
    fileId: string,
    currentUserId?: string,
  ): Promise<void> {
    if (currentUserId) {
      await this.accessPolicy.assertCanAccess(currentUserId, fileId, 'read');
      return;
    }
    const node = await this.nodeRepo.findById(fileId);
    if (!node || node.isTrashed()) {
      throw new NotFoundException('File not found or has been trashed');
    }

    const metadata = (node.metadata || {}) as {
      isPublic?: boolean;
      embargoUntil?: string;
    };
    if (!metadata.isPublic) {
      throw new ForbiddenException(
        'Authentication required to access private research file',
      );
    }
    if (metadata.embargoUntil && new Date(metadata.embargoUntil) > new Date()) {
      throw new ForbiddenException('File is currently under academic embargo');
    }
  }

  async streamR2Object(
    key: string,
    rangeHeader?: string,
  ): Promise<{
    Body?: NodeJS.ReadableStream;
    ContentType?: string;
    ContentLength?: number;
    ContentRange?: string;
    ETag?: string;
  }> {
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
      Body: res.stream,
      ContentType: 'application/octet-stream',
      ContentLength: res.contentLength,
      ContentRange: res.contentRange,
    };
  }

  private async resolveNodeAndBlob(nodeId: string) {
    const node = await this.nodeRepo.findById(nodeId);
    if (!node || node.isTrashed()) {
      throw new NotFoundException('File not found or has been trashed');
    }

    if (!node.blobId) {
      throw new NotFoundException(
        'Logical node has no physical binary attached',
      );
    }

    const blob = await this.blobService.findBlobById(node.blobId);
    if (!blob) {
      throw new NotFoundException('Physical blob not found');
    }

    return { node, blob };
  }

  async stream(
    nodeId: string,
    rangeHeader?: string,
    ifNoneMatch?: string,
  ): Promise<StreamBinaryOutput> {
    const { node, blob } = await this.resolveNodeAndBlob(nodeId);

    const totalSize = Number(blob.sizeBytes);
    const etag = blob.contentHash?.toHex
      ? `"${blob.contentHash.toHex()}"`
      : undefined;

    // RFC 7232 Short-Circuit: Zero driver network/disk I/O on 304 Not Modified
    if (etag && ifNoneMatch && ifNoneMatch === etag && !rangeHeader) {
      return {
        stream: null,
        statusCode: 304,
        mimeType: node.mimeType,
        contentLength: 0,
        filename: node.name,
        etag,
      };
    }

    const byteRange = ByteRange.parse(rangeHeader, totalSize);

    if (byteRange) {
      const { stream } = await this.blobService.getStream(blob.s3Key.value(), {
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
    const { stream } = await this.blobService.getStream(blob.s3Key.value());
    return {
      stream,
      statusCode: 200,
      mimeType: node.mimeType,
      contentLength: totalSize,
      filename: node.name,
      etag,
    };
  }

  async getPresignedDownloadUrl(
    fileId: string,
    expiresInSeconds = 3600,
    userId?: string,
  ): Promise<string> {
    if (userId) {
      await this.verifyReadAccess(fileId, userId);
    }
    const { node, blob } = await this.resolveNodeAndBlob(fileId);

    const cacheKey = `${node.id}:${node.name}`;
    const cachedUrl = await this.cache.getPresignedUrl(cacheKey);
    if (cachedUrl) {
      return cachedUrl;
    }

    const signedUrl = await this.blobService.getPresignedDownloadUrl(
      blob.s3Key.value(),
      {
        expiresInSeconds,
        filename: node.name,
      },
    );

    if (expiresInSeconds > 300) {
      const ttl = Math.min(expiresInSeconds - 300, 3300);
      await this.cache
        .setPresignedUrl(cacheKey, signedUrl, ttl)
        .catch((err: unknown) => {
          this.logger.debug(
            `Failed to cache presigned URL: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    }

    return signedUrl;
  }

  private static readonly MAX_BULK_ZIP_BYTES = 500 * 1024 * 1024; // 500 MB safety guard

  async buildBulkZipArchive(rawIds: string[]): Promise<Buffer> {
    const zip = new ZipPackager();
    const visited = new Set<string>();
    let accumulatedBytes = 0;

    const addNodeToZip = async (
      node: StorageNode,
      currentPath = '',
      depth = 0,
    ) => {
      if (node.isTrashed() || depth > 25) return;
      if (visited.has(node.id)) return;
      visited.add(node.id);

      if (node.isFolder) {
        const cleanFolder = sanitizeFilename(node.name);
        const folderPath = currentPath
          ? `${currentPath}/${cleanFolder}`
          : cleanFolder;
        const children = await this.nodeRepo.list({
          userId: node.authorId,
          projectId: node.projectId,
          parentId: node.id,
          limit: 1000,
        });
        for (const child of children.nodes) {
          await addNodeToZip(child, folderPath, depth + 1);
        }
      } else if (node.blobId) {
        try {
          const { stream } = await this.blobService.openStream(node.blobId);
          const chunks: Buffer[] = [];
          for await (const chunk of stream) {
            const bufChunk = Buffer.isBuffer(chunk)
              ? chunk
              : Buffer.from(chunk);
            accumulatedBytes += bufChunk.length;
            if (accumulatedBytes > StreamService.MAX_BULK_ZIP_BYTES) {
              break;
            }
            chunks.push(bufChunk);
          }
          if (accumulatedBytes > StreamService.MAX_BULK_ZIP_BYTES) {
            return;
          }
          const buf = Buffer.concat(chunks);
          const cleanFileName = sanitizeFilename(node.name);
          const entryName = currentPath
            ? `${currentPath}/${cleanFileName}`
            : cleanFileName;
          zip.addFile(entryName, buf, node.updatedAt);
        } catch (err: unknown) {
          this.logger.debug(
            `Skipping missing physical blob ${node.blobId} for node ${node.id}: ${(err as Error)?.message}`,
          );
        }
      }
    };

    for (const id of rawIds) {
      const node = await this.nodeRepo.findById(id);
      if (node) {
        await addNodeToZip(node);
      }
    }

    return zip.buildAsync();
  }
}
