import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import {
  FILES_PORT,
  sanitizeFilename,
  type IFilesPort,
  type StreamBlobTarget,
} from '@/modules/files';
import { EXPERIMENT_NODE_REPOSITORY } from '../experiments.constant';
import { StreamBinaryOutput } from '../experiments.type';
import { INodeRepository } from '../repositories/node.repository';
import { ExperimentNode } from '../domain/node.domain';
import { ExperimentsAccessPolicy } from '../domain/access.policy';
import { ZipPackager } from '../domain/archive.domain';
import { ExperimentsCacheService } from './cache.service';

export type { StreamBinaryOutput };

interface CachedStreamNodeMeta {
  node: unknown;
  blob: {
    id: string;
    s3Key: string;
    s3Bucket?: string;
    sizeBytes: string;
    contentHashHex?: string;
  };
}

@Injectable()
export class StreamService {
  private readonly logger = new Logger(StreamService.name);

  constructor(
    @Inject(FILES_PORT)
    private readonly filesPort: IFilesPort,
    @Inject(EXPERIMENT_NODE_REPOSITORY)
    private readonly nodeRepo: INodeRepository,
    private readonly cache: ExperimentsCacheService,
    private readonly accessPolicy: ExperimentsAccessPolicy,
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

  private async resolveNodeAndBlob(
    nodeId: string,
  ): Promise<{ node: ExperimentNode; blob: StreamBlobTarget }> {
    const cached = await Promise.resolve(
      this.cache?.getStreamNodeMeta?.<CachedStreamNodeMeta>(nodeId),
    ).catch(() => null);

    if (cached?.node && cached?.blob) {
      const node = ExperimentNode.fromSerialized(cached.node);
      if (!node || node.isTrashed() || !node.blobId) {
        throw new NotFoundException('File not found or has been trashed');
      }

      const blob: StreamBlobTarget = {
        s3Key: cached.blob.s3Key,
        sizeBytes: BigInt(cached.blob.sizeBytes || '0'),
        contentHashHex:
          cached.blob.contentHashHex &&
          /^[a-f0-9]{64}$/i.test(cached.blob.contentHashHex)
            ? cached.blob.contentHashHex
            : undefined,
      };

      return { node, blob };
    }

    const node = await this.nodeRepo.findById(nodeId);
    if (!node || node.isTrashed()) {
      throw new NotFoundException('File not found or has been trashed');
    }

    if (!node.blobId) {
      throw new NotFoundException(
        'Logical node has no physical binary attached',
      );
    }

    const blob = await this.filesPort.findBlobById(node.blobId);
    if (!blob) {
      throw new NotFoundException('Physical blob not found');
    }

    const serializedNode =
      typeof node.toJSON === 'function' ? node.toJSON() : node;
    const rawBlob = blob as unknown as {
      id: string;
      s3Key?: { value?: () => string } | string;
      s3Bucket?: string;
      sizeBytes?: bigint | number | string;
      contentHash?: { toHex?: () => string };
    };
    const s3Key =
      typeof rawBlob.s3Key === 'object' &&
      rawBlob.s3Key !== null &&
      typeof rawBlob.s3Key.value === 'function'
        ? rawBlob.s3Key.value()
        : String(rawBlob.s3Key ?? '');
    const contentHashHex =
      typeof rawBlob.contentHash?.toHex === 'function'
        ? rawBlob.contentHash.toHex()
        : undefined;
    const sizeBytesStr =
      rawBlob.sizeBytes !== undefined && rawBlob.sizeBytes !== null
        ? rawBlob.sizeBytes.toString()
        : '0';

    const payload: CachedStreamNodeMeta = {
      node: serializedNode,
      blob: {
        id: rawBlob.id,
        s3Key,
        s3Bucket: rawBlob.s3Bucket || 'local-storage',
        sizeBytes: sizeBytesStr,
        contentHashHex,
      },
    };
    Promise.resolve(this.cache?.setStreamNodeMeta?.(nodeId, payload, 60)).catch(
      () => {},
    );

    return { node, blob };
  }

  async stream(
    nodeId: string,
    rangeHeader?: string,
    ifNoneMatch?: string,
  ): Promise<StreamBinaryOutput> {
    const { node, blob } = await this.resolveNodeAndBlob(nodeId);

    return this.filesPort.streamBlob(blob, {
      rangeHeader,
      ifNoneMatch,
      mimeType: node.mimeType,
      filename: node.name,
    });
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
    const s3Key =
      typeof blob.s3Key === 'string' ? blob.s3Key : blob.s3Key.value();

    const cacheKey = `${node.id}:${node.name}`;
    const cachedUrl = await this.cache.getPresignedUrl(cacheKey);
    if (cachedUrl) {
      return cachedUrl;
    }

    const signedUrl = await this.filesPort.getPresignedDownloadUrl(s3Key, {
      expiresInSeconds,
      filename: node.name,
    });

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

  private static readonly MAX_BULK_ZIP_BYTES = 500 * 1024 * 1024;

  async buildBulkZipArchive(rawIds: string[]): Promise<Buffer> {
    const zip = new ZipPackager();
    const visited = new Set<string>();
    let accumulatedBytes = 0;

    const addNodeToZip = async (
      node: ExperimentNode,
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
          const { stream } = await this.filesPort.openBlobStream(node.blobId);
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
