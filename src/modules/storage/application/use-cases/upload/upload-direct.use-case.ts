import {
  Injectable,
  Inject,
  Optional,
  BadRequestException,
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
import { ContentHash } from '../../../domain/value-objects/content-hash.vo';
import { StorageKey } from '../../../domain/value-objects/storage-key.vo';
import { FileScope } from '../../../domain/value-objects/file-scope.vo';
import {
  StorageBlob,
  BlobStatus,
} from '../../../domain/entities/storage-blob.entity';
import { StorageNode } from '../../../domain/entities/storage-node.entity';
import { FileUploadedEvent } from '../../../domain/events/file-uploaded.event';
import { StorageRedisCacheService } from '../../../infrastructure/cache/storage-redis-cache.service';
import { StorageQueueProducer } from '../../queues/storage-queue.producer';
import {
  validateMagicBytes,
  sanitizeFilename,
} from '../../../domain/value-objects/file-validator.util';

export interface UploadDirectInput {
  userId: string;
  filename: string;
  buffer: Buffer;
  mimeType: string;
  projectId?: string | null;
  parentId?: string | null;
  scope?: FileScope;
  source?: string;
}

export interface UploadDirectOutput {
  fileId: string;
  blobId: string;
  url: string;
  filename: string;
  size: number;
  mimeType: string;
  isDeduplicated: boolean;
}

@Injectable()
export class UploadDirectUseCase {
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

  async execute(input: UploadDirectInput): Promise<UploadDirectOutput> {
    const scopeKey = input.projectId ?? input.userId;
    const sizeBytes = BigInt(input.buffer.length);

    if (sizeBytes <= 0n) {
      throw new BadRequestException('Cannot upload an empty file');
    }

    const cleanFilename = sanitizeFilename(input.filename);
    validateMagicBytes(input.buffer, input.mimeType, cleanFilename);

    // 1. Content-Addressable Hashing (SHA-256)
    const contentHash = ContentHash.fromBuffer(input.buffer);
    const hashHex = contentHash.toHex();

    // 2. CAS Deduplication Check (Content-Addressable Storage)
    const existingBlob = await this.blobRepo.findByHash(contentHash);
    let blobId: string;
    let isDeduplicated = false;

    if (existingBlob && existingBlob.isReady()) {
      // Blob exists: increment reference count (Zero WAN bandwidth)
      existingBlob.incrementRef();
      await this.blobRepo.update(existingBlob);
      blobId = existingBlob.id;
      isDeduplicated = true;
    } else {
      // 3. New Blob: Check and consume Quota
      await this.quotaRepo.incrementUsage(
        input.userId,
        input.projectId ?? null,
        sizeBytes,
      );

      // 4. Write binary to physical storage driver
      const s3Key = StorageKey.forBlob(hashHex);
      await this.driver.put(s3Key.value(), input.buffer, {
        mimeType: input.mimeType,
        size: input.buffer.length,
      });

      // 5. Persist StorageBlob entity
      const newBlob = new StorageBlob({
        id: crypto.randomUUID(),
        contentHash,
        sizeBytes,
        s3Key,
        s3Bucket: process.env.R2_BUCKET_NAME || 'flux',
        status: BlobStatus.READY,
        refCount: 1,
      });
      await this.blobRepo.create(newBlob);
      blobId = newBlob.id;
    }

    // 6. Create logical StorageNode
    const fileId = crypto.randomUUID();
    const node = new StorageNode({
      id: fileId,
      projectId: input.projectId ?? null,
      parentId: input.parentId ?? null,
      name: cleanFilename,
      isFolder: false,
      size: sizeBytes,
      mimeType: input.mimeType,
      blobId,
      scope:
        input.scope ??
        (input.projectId ? FileScope.Project : FileScope.Personal),
      metadata: input.source ? { source: input.source } : {},
      authorId: input.userId,
    });
    await this.nodeRepo.create(node);

    // 7. Invalidate folder listing cache
    await this.cache.invalidateFolder(scopeKey, input.parentId);

    // 8. Emit domain event for async subscribers (AI indexing, virus scan)
    this.eventEmitter.emit(
      'file.uploaded',
      new FileUploadedEvent(
        fileId,
        blobId,
        input.userId,
        cleanFilename,
        input.mimeType,
        sizeBytes,
        StorageKey.forBlob(hashHex).value(),
        input.projectId,
      ),
    );

    // 9. Enqueue background media/dataset processing job
    if (this.queueProducer) {
      this.queueProducer
        .queueFileProcessing({
          fileId,
          blobId,
          s3Key: StorageKey.forBlob(hashHex).value(),
          mimeType: input.mimeType,
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
      size: Number(sizeBytes),
      mimeType: input.mimeType,
      isDeduplicated,
    };
  }
}
