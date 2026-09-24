import {
  Injectable,
  Inject,
  BadRequestException,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as crypto from 'crypto';
import {
  STORAGE_DRIVER,
  STORAGE_NODE_REPOSITORY,
  STORAGE_BLOB_REPOSITORY,
  STORAGE_QUOTA_REPOSITORY,
} from '../../../storage.tokens';
import { IStorageDriver } from '../../../domain/ports/storage-driver.port';
import { IStorageNodeRepository } from '../../../domain/ports/storage-node.repository.port';
import { IStorageBlobRepository } from '../../../domain/ports/storage-blob.repository.port';
import { IStorageQuotaRepository } from '../../../domain/ports/storage-quota.repository.port';
import { StorageRedisCacheService } from '../../../infrastructure/cache/storage-redis-cache.service';
import {
  StorageBlob,
  BlobStatus,
} from '../../../domain/entities/storage-blob.entity';
import { StorageNode } from '../../../domain/entities/storage-node.entity';
import { ContentHash } from '../../../domain/value-objects/content-hash.vo';
import { StorageKey } from '../../../domain/value-objects/storage-key.vo';
import { FileScope } from '../../../domain/value-objects/file-scope.vo';
import { FileUploadedEvent } from '../../../domain/events/file-uploaded.event';
import {
  isBlockedExtension,
  sanitizeFilename,
  validateMagicBytes,
} from '../../../domain/value-objects/file-validator.util';
import { StorageQueueProducer } from '../../queues/storage-queue.producer';

export interface CompletePresignInput {
  userId: string;
  storageKey: string;
  filename: string;
  sizeBytes?: number;
  mimeType?: string;
  projectId?: string | null;
  parentId?: string | null;
  scope?: FileScope;
  contentHash?: string;
}

export interface CompletePresignOutput {
  fileId: string;
  blobId: string;
  url: string;
  filename: string;
  size: number;
  mimeType: string;
}

@Injectable()
export class CompletePresignUseCase {
  constructor(
    @Inject(STORAGE_DRIVER) private readonly driver: IStorageDriver,
    @Inject(STORAGE_NODE_REPOSITORY)
    private readonly nodeRepo: IStorageNodeRepository,
    @Inject(STORAGE_BLOB_REPOSITORY)
    private readonly blobRepo: IStorageBlobRepository,
    @Inject(STORAGE_QUOTA_REPOSITORY)
    private readonly quotaRepo: IStorageQuotaRepository,
    private readonly cache: StorageRedisCacheService,
    private readonly eventEmitter: EventEmitter2,
    @Optional() private readonly queueProducer?: StorageQueueProducer,
  ) {}

  async execute(input: CompletePresignInput): Promise<CompletePresignOutput> {
    const cleanFilename = sanitizeFilename(input.filename);
    if (isBlockedExtension(cleanFilename)) {
      throw new BadRequestException(
        'File extension is prohibited for security reasons',
      );
    }

    // 1. Verify object existence in physical driver
    let actualSize = input.sizeBytes ? BigInt(input.sizeBytes) : 0n;
    let actualMime = input.mimeType || 'application/octet-stream';

    try {
      const stat = await this.driver.stat(input.storageKey);
      if (stat && stat.size > 0) {
        actualSize = BigInt(stat.size);
        if (stat.mimeType && stat.mimeType !== 'application/octet-stream') {
          actualMime = stat.mimeType;
        }
      }
    } catch {
      // If stat fails, check if caller provided non-zero size
      if (actualSize <= 0n) {
        throw new NotFoundException(
          'Uploaded object not found or verified in storage backend',
        );
      }
    }

    // 1.1 Verify binary magic bytes to prevent MIME spoofing & executable upload bypass (SEC-003)
    try {
      const streamRes = await this.driver.getStream(input.storageKey, {
        start: 0,
        end: 511,
      });
      if (streamRes && streamRes.stream) {
        const chunks: Buffer[] = [];
        for await (const chunk of streamRes.stream) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const headerBuffer = Buffer.concat(chunks);
        if (headerBuffer.length > 0) {
          validateMagicBytes(headerBuffer, actualMime, cleanFilename);
        }
      }
    } catch (err: any) {
      if (err instanceof BadRequestException) {
        // Immediate cleanup of malicious payload from physical storage
        this.driver.delete(input.storageKey).catch(() => {});
        throw err;
      }
    }

    const scopeKey = input.projectId ?? input.userId;

    // 2. Check and consume Quota
    await this.quotaRepo.incrementUsage(
      input.userId,
      input.projectId ?? null,
      actualSize,
    );

    // 3. Register physical StorageBlob (Content-Addressable Storage)
    const hashHex =
      input.contentHash && /^[a-f0-9]{64}$/i.test(input.contentHash)
        ? input.contentHash.toLowerCase()
        : crypto
            .createHash('sha256')
            .update(`${input.storageKey}:${actualSize}`)
            .digest('hex');
    const contentHash = ContentHash.fromHex(hashHex);

    const existingBlob = await this.blobRepo.findByHash(contentHash);
    let blobId: string;

    if (existingBlob && existingBlob.isReady()) {
      existingBlob.incrementRef();
      await this.blobRepo.update(existingBlob);
      blobId = existingBlob.id;

      // Cost Optimization: Immediately reclaim redundant physical S3/R2 object
      // to eliminate orphan storage cost leaks when identical blob already exists.
      if (input.storageKey !== existingBlob.s3Key.value()) {
        this.driver.delete(input.storageKey).catch((err: any) => {
          // Non-blocking catch to prevent failing the response
        });
      }
    } else {
      blobId = crypto.randomUUID();
      const blob = new StorageBlob({
        id: blobId,
        contentHash,
        sizeBytes: actualSize,
        s3Key: StorageKey.fromString(input.storageKey),
        s3Bucket: process.env.R2_BUCKET_NAME || 'flux',
        status: BlobStatus.READY,
        refCount: 1,
      });
      await this.blobRepo.create(blob);
    }

    // 4. Create logical StorageNode
    const fileId = crypto.randomUUID();
    const node = new StorageNode({
      id: fileId,
      projectId: input.projectId ?? null,
      parentId: input.parentId ?? null,
      name: cleanFilename,
      isFolder: false,
      size: actualSize,
      mimeType: actualMime,
      blobId,
      scope:
        input.scope ??
        (input.projectId ? FileScope.Project : FileScope.Personal),
      authorId: input.userId,
    });
    await this.nodeRepo.create(node);

    // 5. Invalidate folder listing cache
    await this.cache.invalidateFolder(scopeKey, input.parentId ?? null);

    // 6. Emit domain event
    this.eventEmitter.emit(
      'file.uploaded',
      new FileUploadedEvent(
        fileId,
        blobId,
        input.userId,
        cleanFilename,
        actualMime,
        actualSize,
        input.storageKey,
        input.projectId,
      ),
    );

    // 7. Enqueue background media/dataset processing job
    if (this.queueProducer) {
      this.queueProducer
        .queueFileProcessing({
          fileId,
          blobId,
          s3Key: input.storageKey,
          mimeType: actualMime,
          filename: cleanFilename,
          userId: input.userId,
          projectId: input.projectId,
        })
        .catch(() => {});
    }

    return {
      fileId,
      blobId,
      url: `/api/files/${encodeURIComponent(fileId)}/content`,
      filename: cleanFilename,
      size: Number(actualSize),
      mimeType: actualMime,
    };
  }
}
